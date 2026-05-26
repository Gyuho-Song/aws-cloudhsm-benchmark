#!/usr/bin/env bash
# Create the CloudHSM v2 cluster + HSMs + initialize + activate. Run AFTER `cdk deploy CoreStack`.
#
# Why this lives outside CDK: AWS::CloudHSMV2::{Cluster,Hsm} aren't CFN resource
# types, and walking the cloudhsm SDK from a CFN custom resource exceeds the
# 2-hour Custom Resource framework ceiling for 6 sequential HSM creates.
#
# Steps (per AWS CloudHSM v2 + hsm2m.medium docs):
#   1. CreateCluster                       -> CREATE_IN_PROGRESS -> UNINITIALIZED
#   2. Generate ephemeral CA, persist to Secrets Manager
#   3. CreateHsm #1                        -> ACTIVE
#   4. Sign cluster CSR + InitializeCluster -> INITIALIZE_IN_PROGRESS -> INITIALIZED
#   5. SG bridge: cloudhsmv2 auto-creates ITS OWN SG for HSM ENIs (ignores any SG
#      I tried to assign). Add a loader-egress + auto-SG-ingress on TCP 2223-2225.
#   6. Patch /opt/cloudhsm/etc/cloudhsm-cli.cfg "type" to "hsm2m" (configure-cli
#      defaults to "hsm1"; cloudhsm-cli >=5.17 supports hsm2m but only via
#      direct config edit, no flag yet).
#   7. cloudhsm-cli cluster activate --password <CO_PW>  -> cluster ACTIVE (~1 min)
#   8. CreateHsm #2..N sequentially       -> all ACTIVE
#   9. Persist /hsm-bmt/core/cluster-id (or cluster-id-1..N for multi-cluster)
#
# 2026-05-24 multi-cluster scale-out (us-west-2 plan): when SSM
# /hsm-bmt/core/cluster-count > 1, the script loops over per-cluster slot
# configs (/hsm-bmt/core/hsm-slots-1, hsm-slots-2, ...) and creates a separate
# cluster for each, publishing IDs to /hsm-bmt/core/cluster-id-1..N. The first
# cluster's ID is also aliased to /hsm-bmt/core/cluster-id for backwards-compat
# with single-cluster downstream code.
#
# Inputs (read from SSM Parameter Store under /hsm-bmt/core/):
#   Single-cluster (default):
#     - subnet-ids-csv
#     - hsm-slots               (JSON array of {logicalId, az})
#     - desired-hsm-count
#     - loader-instance-id      (running cloudhsm-cli)
#     - co-password-secret-arn  (used to activate)
#   Multi-cluster (clusterCount > 1):
#     - cluster-count           (N)
#     - hsm-slots-{1..N}        (per-cluster JSON arrays)
#     - hsms-per-cluster        (count per cluster, e.g. 2)
#
# Outputs:
#   Single-cluster:
#     - /hsm-bmt/core/cluster-id  (SSM)
#   Multi-cluster:
#     - /hsm-bmt/core/cluster-id-1..N  (SSM)
#     - /hsm-bmt/core/cluster-id        (alias = cluster-id-1)
#   - hsm-bmt/ca-private-key            (Secrets Manager) updated with the new CA
# set -u (nounset) removed 2026-05-24: heredoc escaping for embedded SSM
# RunShellScript inside cloudhsm-cli activate triggers spurious "unbound
# variable" on shell-side $vars that are actually evaluated remotely. We
# keep -e (exit on error) and -o pipefail; nounset would fail safely on the
# escape-quoted heredoc despite the script being correct.
set -eo pipefail
REGION=${AWS_REGION:-ap-northeast-2}
HSM_TYPE=hsm2m.medium
MODE=FIPS

# 2026-05-24 multi-cluster: log() goes to stderr so the multi-cluster path's
# `CID=$(create_one_cluster ... | tail -1)` capture works (function returns
# CLUSTER_ID via stdout, but log() messages would otherwise pollute stdout
# and tail would pick a log line instead of the cluster id).
log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
ssm_get() { aws ssm get-parameter --region "$REGION" --name "$1" --query Parameter.Value --output text; }
ssm_get_or() { aws ssm get-parameter --region "$REGION" --name "$1" --query Parameter.Value --output text 2>/dev/null || echo "$2"; }
ssm_put() { aws ssm put-parameter --region "$REGION" --name "$1" --value "$2" --type String --overwrite >/dev/null; }
desc_cluster() {
  # Forward extra args ($2+) to aws so callers can pass --query / --output.
  local cid="$1"; shift
  aws cloudhsmv2 describe-clusters --region "$REGION" --filters "clusterIds=$cid" "$@"
}

# Common (cluster-count agnostic) inputs
SUBNETS_CSV=$(ssm_get /hsm-bmt/core/subnet-ids-csv)
LOADER_ID=$(ssm_get /hsm-bmt/core/loader-instance-id)
LOADER_SG=$(ssm_get /hsm-bmt/core/loader-sg-id)
CA_SECRET_NAME=hsm-bmt/ca-private-key
CO_SECRET_NAME=hsm-bmt/co-password

# Multi-cluster detection: defaults to 1 (single-cluster path) when SSM key absent.
CLUSTER_COUNT=$(ssm_get_or /hsm-bmt/core/cluster-count 1)

# 2026-05-24 multi-cluster: hsm-cluster-construct.ts publishes per-cluster
# slot configs with logical AZ placeholders ('logical-az-1', 'logical-az-2',
# ...). Resolve to actual region AZs (us-west-2a, us-west-2b, ...) via
# describe-availability-zones at runtime.
mapfile -t REGION_AZS < <(aws ec2 describe-availability-zones --region "$REGION" \
  --filters "Name=state,Values=available" --query 'AvailabilityZones[].ZoneName' --output text | tr '\t' '\n')
log "Region AZs available: ${REGION_AZS[*]}"

resolve_logical_az() {
  # logical-az-N → REGION_AZS[N-1]
  local logical=$1
  case "$logical" in
    logical-az-1) echo "${REGION_AZS[0]}" ;;
    logical-az-2) echo "${REGION_AZS[1]}" ;;
    logical-az-3) echo "${REGION_AZS[2]}" ;;
    logical-az-4) echo "${REGION_AZS[3]}" ;;
    *) echo "$logical" ;;  # already real AZ (single-cluster path uses real names)
  esac
}

log "Subnets: $SUBNETS_CSV"
log "Loader: $LOADER_ID (sg=$LOADER_SG)"
log "Cluster count: $CLUSTER_COUNT"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Generate CA once — same CA is signed onto every cluster (so the loader's
# /opt/cloudhsm/etc/customerCA.crt works for all clusters).
log "Generate ephemeral CA (shared across all clusters)"
openssl req -newkey rsa:2048 -nodes -days 30 -x509 \
  -subj "/CN=hsm-bmt-ephemeral-ca" \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null
CA_JSON=$(jq -n --rawfile c "$WORK/ca.crt" --rawfile k "$WORK/ca.key" '{certificate:$c, privateKey:$k}')
aws secretsmanager put-secret-value --region "$REGION" \
  --secret-id "$CA_SECRET_NAME" --secret-string "$CA_JSON" >/dev/null

# ----------------------------------------------------------------------------
# Per-cluster create function. Args:
#   $1 = cluster index (1-based), used for log prefix and SSM output key
#   $2 = SLOTS_JSON for this cluster
#   $3 = DESIRED count for this cluster
# Returns: prints CLUSTER_ID on stdout
# ----------------------------------------------------------------------------
create_one_cluster() {
  local CIDX=$1 SLOTS_JSON=$2 DESIRED=$3
  local PFX="[c$CIDX]"
  log "$PFX Step 1: CreateCluster ($HSM_TYPE, $MODE)"
  local SUBNET_IDS
  SUBNET_IDS=$(echo "$SUBNETS_CSV" | tr ',' ' ')
  local CLUSTER_JSON CLUSTER_ID
  CLUSTER_JSON=$(aws cloudhsmv2 create-cluster --region "$REGION" \
    --hsm-type "$HSM_TYPE" --mode "$MODE" --subnet-ids $SUBNET_IDS \
    --backup-retention-policy 'Type=DAYS,Value=7' \
    --tag-list "Key=hsm-bmt:role,Value=cluster" "Key=hsm-bmt:cluster-idx,Value=$CIDX")
  CLUSTER_ID=$(echo "$CLUSTER_JSON" | jq -r '.Cluster.ClusterId')
  log "$PFX Created cluster $CLUSTER_ID"

  local STATE
  while true; do
    STATE=$(desc_cluster "$CLUSTER_ID" --query 'Clusters[0].State' --output text)
    log "$PFX   cluster state: $STATE"
    case "$STATE" in
      UNINITIALIZED) break ;;
      CREATE_IN_PROGRESS) sleep 30 ;;
      *) log "$PFX Unexpected state $STATE"; exit 1 ;;
    esac
  done

  # Tag CA secret with this cluster ID (concat tag — multi-cluster reuses the
  # same secret but tracks which clusters it has signed)
  aws secretsmanager tag-resource --region "$REGION" \
    --secret-id "$CA_SECRET_NAME" \
    --tags "Key=hsm-bmt-cluster-id-$CIDX,Value=$CLUSTER_ID" >/dev/null

  # ---- 3. CreateHsm #1 ------------------------------------------------------
  local FIRST_AZ_LOGICAL FIRST_AZ HSM1
  FIRST_AZ_LOGICAL=$(echo "$SLOTS_JSON" | jq -r '.[0].az')
  FIRST_AZ=$(resolve_logical_az "$FIRST_AZ_LOGICAL")
  log "$PFX Step 3: CreateHsm #1 in $FIRST_AZ (from $FIRST_AZ_LOGICAL)"
  HSM1=$(aws cloudhsmv2 create-hsm --region "$REGION" --cluster-id "$CLUSTER_ID" \
    --availability-zone "$FIRST_AZ" --query 'Hsm.HsmId' --output text)
  log "$PFX   HsmId: $HSM1"
  local HSTATE
  while true; do
    HSTATE=$(desc_cluster "$CLUSTER_ID" --query "Clusters[0].Hsms[?HsmId=='$HSM1'].State" --output text)
    log "$PFX     $HSM1: $HSTATE"
    case "$HSTATE" in
      ACTIVE) break ;;
      CREATE_IN_PROGRESS) sleep 30 ;;
      *) log "$PFX Unexpected state $HSTATE"; exit 1 ;;
    esac
  done

  # ---- 4. Sign cluster CSR + InitializeCluster ------------------------------
  log "$PFX Step 4: sign CSR + InitializeCluster"
  local CSR
  CSR=$(desc_cluster "$CLUSTER_ID" --query 'Clusters[0].Certificates.ClusterCsr' --output text)
  echo "$CSR" > "$WORK/cluster-$CIDX.csr"
  openssl x509 -req -in "$WORK/cluster-$CIDX.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
    -set_serial "$CIDX" -days 30 -out "$WORK/cluster-$CIDX.crt" 2>/dev/null
  aws cloudhsmv2 initialize-cluster --region "$REGION" --cluster-id "$CLUSTER_ID" \
    --signed-cert "file://$WORK/cluster-$CIDX.crt" \
    --trust-anchor "file://$WORK/ca.crt" >/dev/null
  while true; do
    STATE=$(desc_cluster "$CLUSTER_ID" --query 'Clusters[0].State' --output text)
    log "$PFX   cluster state: $STATE"
    [ "$STATE" = "INITIALIZED" ] && break
    sleep 30
  done

  # ---- 5. SG bridge: loader -> CloudHSM auto-SG -----------------------------
  log "$PFX Step 5: bridge loader-SG <-> CloudHSM auto-SG (TCP 2223-2225)"
  local HSM_ENI_IP HSM_AUTO_SG
  HSM_ENI_IP=$(desc_cluster "$CLUSTER_ID" --query 'Clusters[0].Hsms[0].EniIp' --output text)
  HSM_AUTO_SG=$(aws ec2 describe-network-interfaces --region "$REGION" \
    --filters "Name=addresses.private-ip-address,Values=$HSM_ENI_IP" \
    --query 'NetworkInterfaces[0].Groups[0].GroupId' --output text)
  log "$PFX   HSM auto-SG: $HSM_AUTO_SG (HSM ENI $HSM_ENI_IP)"
  # Idempotent: ignore "already exists"
  aws ec2 authorize-security-group-egress --region "$REGION" --group-id "$LOADER_SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=2223,ToPort=2225,UserIdGroupPairs=[{GroupId=$HSM_AUTO_SG,Description='CloudHSM SDK5 to auto-SG c$CIDX'}]" \
    >/dev/null 2>&1 || true
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$HSM_AUTO_SG" \
    --protocol tcp --port 2223 --source-group "$LOADER_SG" \
    >/dev/null 2>&1 || true

  # ---- 6+7. cloudhsm-cli config patch + activate (via SSM on the loader) ---
  log "$PFX Step 6+7: configure cloudhsm-cli for hsm2m + cluster activate"
  # NOTE: configure-cli rewrites cloudhsm-cli.cfg with the latest --cluster-id
  # passed. Multi-cluster operators activate each cluster sequentially; the
  # last activate-call's --cluster-id wins inside cloudhsm-cli.cfg, but that
  # is fine because cloudhsm-cli is only used for activation here, not for
  # runtime PKCS#11 (which goes via configure-pkcs11 add-cluster on the loader
  # bootstrap, see loader-bootstrap.sh).
  #
  # 2026-05-24 rewrite: build the SSM Parameters JSON via `jq -n` rather than
  # bash double-quoted JSON literal. The original form had two latent bugs:
  #   (a) `\\$(aws secretsmanager ...)` evaluated host-side, baking the
  #       random CO password into the JSON — broke when password contained
  #       JSON-invalid escape sequences (`\G...`).
  #   (b) `\\$CO_PW` in the heredoc body produced a literal `\` on the host
  #       and an empty `$CO_PW` (host had no such var), so the remote
  #       cluster activate received no password.
  # jq -n + array-of-strings construction eliminates all quoting issues and
  # is verified via `jq empty` before SSM send-command.
  #
  # The remote bash sees one script (SSM AWS-RunShellScript joins commands
  # with newlines): set CO_PW from secretsmanager, then call
  # `cloudhsm-cli cluster activate --password "$CO_PW"` directly (no
  # interactive heredoc — the subcommand form exists since cloudhsm-cli 5.x).
  local SSM_PARAMS
  SSM_PARAMS=$(jq -n \
    --arg region   "$REGION" \
    --arg cluster  "$CLUSTER_ID" \
    --arg ca_sec   "$CA_SECRET_NAME" \
    --arg co_sec   "$CO_SECRET_NAME" \
    '{
      commands: [
        "set -e",
        "export AWS_REGION=" + $region,
        "aws secretsmanager get-secret-value --region " + $region + " --secret-id " + $ca_sec + " --query SecretString --output text | jq -r .certificate > /opt/cloudhsm/etc/customerCA.crt",
        "chmod 644 /opt/cloudhsm/etc/customerCA.crt",
        "/opt/cloudhsm/bin/configure-cli --cluster-id " + $cluster + " --region " + $region + " --hsm-ca-cert /opt/cloudhsm/etc/customerCA.crt 2>&1 || /opt/cloudhsm/bin/configure-cli --cluster-id " + $cluster + " --region " + $region + " 2>&1",
        "jq \".clusters[0].type = \\\"hsm2m\\\"\" /opt/cloudhsm/etc/cloudhsm-cli.cfg > /tmp/c.json && cp /tmp/c.json /opt/cloudhsm/etc/cloudhsm-cli.cfg",
        "CO_PW=$(aws secretsmanager get-secret-value --region " + $region + " --secret-id " + $co_sec + " --query SecretString --output text)",
        "/opt/cloudhsm/bin/cloudhsm-cli cluster activate --password \"$CO_PW\""
      ]
    }')
  # Sanity check: validate JSON before send-command. If jq emits anything
  # other than valid JSON, fail fast with a clear error rather than letting
  # AWS CLI produce a confusing "Invalid JSON" trace.
  echo "$SSM_PARAMS" | jq empty 2>/dev/null || {
    log "$PFX SSM_PARAMS JSON is invalid:"; echo "$SSM_PARAMS" >&2; exit 1
  }
  local CMD_ID
  CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$LOADER_ID" \
    --document-name AWS-RunShellScript --comment "cloudhsm-cli activate $CLUSTER_ID" \
    --parameters "$SSM_PARAMS" --query 'Command.CommandId' --output text)
  log "$PFX   SSM cmd: $CMD_ID"
  sleep 30
  local CSTATUS
  while true; do
    CSTATUS=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$LOADER_ID" --query Status --output text)
    log "$PFX   ssm status: $CSTATUS"
    case "$CSTATUS" in
      Success) break ;;
      InProgress|Pending) sleep 15 ;;
      *) log "$PFX SSM activate failed: $CSTATUS"; aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$LOADER_ID" --query StandardErrorContent --output text; exit 1 ;;
    esac
  done

  log "$PFX   waiting for ACTIVE..."
  while true; do
    STATE=$(desc_cluster "$CLUSTER_ID" --query 'Clusters[0].State' --output text)
    log "$PFX   cluster state: $STATE"
    [ "$STATE" = "ACTIVE" ] && break
    sleep 30
  done

  # ---- 8. CreateHsm #2..DESIRED ---------------------------------------------
  log "$PFX Step 8: create remaining $((DESIRED - 1)) HSMs"
  local i=0 AZ_LOGICAL AZ HSM_ID
  for AZ_LOGICAL in $(echo "$SLOTS_JSON" | jq -r '.[].az'); do
    i=$((i + 1))
    if [ $i -eq 1 ]; then continue; fi
    AZ=$(resolve_logical_az "$AZ_LOGICAL")
    log "$PFX   CreateHsm #$i in $AZ (from $AZ_LOGICAL)"
    HSM_ID=$(aws cloudhsmv2 create-hsm --region "$REGION" --cluster-id "$CLUSTER_ID" \
      --availability-zone "$AZ" --query 'Hsm.HsmId' --output text)
    log "$PFX     HsmId: $HSM_ID"
    while true; do
      HSTATE=$(desc_cluster "$CLUSTER_ID" --query "Clusters[0].Hsms[?HsmId=='$HSM_ID'].State" --output text)
      log "$PFX     $HSM_ID: $HSTATE"
      case "$HSTATE" in
        ACTIVE) break ;;
        CREATE_IN_PROGRESS) sleep 30 ;;
        *) log "$PFX Unexpected state $HSTATE"; exit 1 ;;
      esac
    done
  done

  log "$PFX DONE: $CLUSTER_ID ACTIVE with $DESIRED HSMs"
  # Print result for caller
  printf '%s\n' "$CLUSTER_ID"
}

# ---- Outer dispatch: single vs multi-cluster -------------------------------

if [ "$CLUSTER_COUNT" -le 1 ]; then
  # Single-cluster path (preserves original SSM keys verbatim)
  SLOTS_JSON=$(ssm_get /hsm-bmt/core/hsm-slots)
  DESIRED=$(ssm_get /hsm-bmt/core/desired-hsm-count)
  log "Single-cluster mode: DESIRED=$DESIRED"
  CLUSTER_ID=$(create_one_cluster 1 "$SLOTS_JSON" "$DESIRED" | tail -1)
  ssm_put /hsm-bmt/core/cluster-id "$CLUSTER_ID"
  log "DONE: cluster $CLUSTER_ID stored at /hsm-bmt/core/cluster-id"
else
  # Multi-cluster path
  HSMS_PER_CLUSTER=$(ssm_get /hsm-bmt/core/hsms-per-cluster)
  log "Multi-cluster mode: $CLUSTER_COUNT clusters × $HSMS_PER_CLUSTER HSMs each"
  CLUSTER_IDS=()
  for CIDX in $(seq 1 "$CLUSTER_COUNT"); do
    SLOTS_JSON=$(ssm_get "/hsm-bmt/core/hsm-slots-$CIDX")
    CID=$(create_one_cluster "$CIDX" "$SLOTS_JSON" "$HSMS_PER_CLUSTER" | tail -1)
    CLUSTER_IDS+=("$CID")
    ssm_put "/hsm-bmt/core/cluster-id-$CIDX" "$CID"
    log "  Stored: /hsm-bmt/core/cluster-id-$CIDX = $CID"
  done
  # Backwards-compat alias: first cluster ID also goes to /hsm-bmt/core/cluster-id
  ssm_put /hsm-bmt/core/cluster-id "${CLUSTER_IDS[0]}"
  log "DONE: $CLUSTER_COUNT clusters created"
  log "  Aliased: /hsm-bmt/core/cluster-id = ${CLUSTER_IDS[0]} (= cluster-id-1)"
  for i in "${!CLUSTER_IDS[@]}"; do
    log "    cluster-id-$((i+1)) = ${CLUSTER_IDS[$i]}"
  done
fi
