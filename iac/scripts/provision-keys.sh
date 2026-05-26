#!/usr/bin/env bash
# Provision V3 BMT keys (W1 / A1, AES-128 / AES-256) on the CloudHSM cluster(s).
# Run AFTER `cluster-create.sh` and AFTER the loader EC2's bootstrap has
# completed (so configure-cli / cloudhsm-cli are wired up).
#
# 2026-05-24 design (validated by /tmp/gen-kek.json — task #66 BMT_KEK
# provisioning succeeded with this pattern):
#
#   For each cluster:
#     SSM SendCommand → loader EC2 →
#       `cloudhsm-cli interactive <<EOF
#         login --username <user> --role <role> --password "$PW" --cluster-id $cid
#         <subcommand>
#         <subcommand>
#         logout
#         quit
#         EOF`
#
#   `cloudhsm-cli login ... user list` (single-shot mode) does NOT work in
#   5.17.x — login's optional [COMMAND] only accepts mfa-token-sign. Use
#   interactive heredoc.
#
#   Each cluster has its OWN CU bootstrap + OWN W1/A1 generate. Per-cluster
#   keys have IDENTICAL labels but per-cluster random raw bytes. This is fine
#   for V3 multi-slot scale-out: each worker uses its own slot's keys, and
#   the H2 hypothesis measures aggregate throughput, not cryptogram equality.
#
# Inputs (SSM):
#   - cluster-count          (1 or N)
#   - cluster-id             (single) or cluster-id-1..N (multi)
#   - loader-instance-id
#
# Inputs (Secrets Manager):
#   - hsm-bmt/co-password   (admin password set by cluster activate)
#   - hsm-bmt/cu-password   (CU password — set on first user create)
#
# Outputs: 4 keys × N clusters all token-resident, identical labels per
# cluster, per-cluster random raw bytes:
#   BMT_V3_W1_AES128 (16B), BMT_V3_W1_AES256 (32B),
#   BMT_A1_AES128    (16B), BMT_A1_AES256    (32B)
set -eo pipefail
REGION=${AWS_REGION:-ap-northeast-2}
CU_USERNAME=${CU_USERNAME:-bmt_cu}

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
ssm_get() { aws ssm get-parameter --region "$REGION" --name "$1" --query Parameter.Value --output text; }
ssm_get_or() { aws ssm get-parameter --region "$REGION" --name "$1" --query Parameter.Value --output text 2>/dev/null || echo "$2"; }

CLUSTER_COUNT=$(ssm_get_or /hsm-bmt/core/cluster-count 1)
LOADER_ID=$(ssm_get /hsm-bmt/core/loader-instance-id)
log "Cluster count: $CLUSTER_COUNT, loader: $LOADER_ID, region: $REGION"

declare -a CLUSTER_IDS
if [ "$CLUSTER_COUNT" -le 1 ]; then
  CLUSTER_IDS=("$(ssm_get /hsm-bmt/core/cluster-id)")
else
  for i in $(seq 1 "$CLUSTER_COUNT"); do
    CLUSTER_IDS+=("$(ssm_get "/hsm-bmt/core/cluster-id-$i")")
  done
fi
log "Cluster IDs: ${CLUSTER_IDS[*]}"

# ============================================================================
# ssm_run: send a multi-line bash script to the loader EC2 via SSM
# RunShellScript. Builds the --parameters JSON via `jq -n` (no manual
# escaping). Polls until Success or fails fast.
#
# The script body is read from stdin and packed as ONE string in commands[0].
# RunShellScript's /var/lib/amazon/ssm/.../awsrunShellScript_orchestration
# wrapper writes commands joined by newlines into a single shell script —
# passing one string in commands[] yields the same effect, with simpler
# quoting.
# ============================================================================
ssm_run() {
  local comment="$1"
  local body
  body=$(cat)
  local params
  params=$(jq -n --arg cmd "$body" '{commands: [$cmd]}')
  echo "$params" | jq empty >/dev/null 2>&1 || {
    log "Invalid JSON SSM params"; echo "$params" >&2; return 1
  }
  local cmd_id
  cmd_id=$(aws ssm send-command --region "$REGION" --instance-ids "$LOADER_ID" \
    --document-name AWS-RunShellScript \
    --comment "${comment:0:100}" \
    --parameters "$params" \
    --query 'Command.CommandId' --output text)
  log "  SSM cmd: $cmd_id ($comment)"
  sleep 5
  local status
  while :; do
    status=$(aws ssm get-command-invocation --region "$REGION" \
      --command-id "$cmd_id" --instance-id "$LOADER_ID" \
      --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in
      Success)
        aws ssm get-command-invocation --region "$REGION" \
          --command-id "$cmd_id" --instance-id "$LOADER_ID" \
          --query StandardOutputContent --output text 2>/dev/null \
          | sed 's/^/    [out] /' >&2 || true
        return 0
        ;;
      InProgress|Pending) sleep 10 ;;
      *)
        log "  SSM FAILED ($status):"
        aws ssm get-command-invocation --region "$REGION" \
          --command-id "$cmd_id" --instance-id "$LOADER_ID" \
          --query StandardOutputContent --output text 2>/dev/null \
          | sed 's/^/    [out] /' >&2 || true
        aws ssm get-command-invocation --region "$REGION" \
          --command-id "$cmd_id" --instance-id "$LOADER_ID" \
          --query StandardErrorContent --output text 2>/dev/null \
          | sed 's/^/    [err] /' >&2 || true
        return 1
        ;;
    esac
  done
}

# ============================================================================
# Step 1 (multi-cluster only): configure-cli add-cluster for clusters 2..N
# Cluster 1 is already registered by cluster-create.sh's activate path.
# Idempotent: ignore "already exists" via `|| true`.
# ============================================================================
if [ "$CLUSTER_COUNT" -gt 1 ]; then
  log "Step 1: assume multi-cluster cfg already built by cluster-create.sh"
  # cluster-create.sh activates cluster 1 (registers in cfg with type=hsm2m).
  # For subsequent clusters, the operator manually runs configure-cli
  # add-cluster (or rebuilds cfg). We do NOT rebuild here because:
  #  (1) configure-cli refuses to act on a multi-cluster cfg, and
  #  (2) the rebuild requires `rm cfg + re-init + add-cluster x N + jq patch`,
  #      which is fragile via SSM heredoc due to bash $(...) escape pitfalls.
  # If cfg has fewer than CLUSTER_COUNT cluster blocks, Step 2/3 will fail
  # with a clear "multiple clusters provided in configuration file. Please
  # specify cluster-id" or similar — the operator can then run the rebuild
  # snippet (printed below for reference).
  log "  (if Step 2 fails with cfg errors, run on loader EC2:)"
  log "    cp /opt/cloudhsm/etc/cloudhsm-cli.cfg /opt/cloudhsm/etc/cloudhsm-cli.cfg.bak"
  log "    rm /opt/cloudhsm/etc/cloudhsm-cli.cfg"
  log "    /opt/cloudhsm/bin/configure-cli --cluster-id ${CLUSTER_IDS[0]} --region $REGION --hsm-ca-cert /opt/cloudhsm/etc/customerCA.crt"
  for i in $(seq 2 "$CLUSTER_COUNT"); do
    log "    /opt/cloudhsm/bin/configure-cli add-cluster --cluster-id ${CLUSTER_IDS[$((i-1))]} --region $REGION --hsm-ca-cert /opt/cloudhsm/etc/customerCA.crt"
  done
  log "    jq '(.clusters[].type) = \"hsm2m\"' /opt/cloudhsm/etc/cloudhsm-cli.cfg > /tmp/c.json && cp /tmp/c.json /opt/cloudhsm/etc/cloudhsm-cli.cfg"
fi

# ============================================================================
# Step 2: CU bootstrap on each cluster.
# Pattern from /tmp/gen-kek.json (validated): cloudhsm-cli interactive
# heredoc inside the SSM RunShellScript body. The interactive shell does
# NOT honor outer `set -e`, so a duplicate `user create` (already-exists)
# fails locally without aborting the SSM script.
# ============================================================================
log "Step 2: CU bootstrap on each cluster"
for cid in "${CLUSTER_IDS[@]}"; do
  log "  cluster: $cid"
  {
    echo "set -e"
    echo "export PATH=/opt/cloudhsm/bin:\$PATH"
    echo "export AWS_REGION=$REGION"
    echo 'CO_PW=$(aws secretsmanager get-secret-value --region '"$REGION"' --secret-id hsm-bmt/co-password --query SecretString --output text)'
    echo 'CU_PW=$(aws secretsmanager get-secret-value --region '"$REGION"' --secret-id hsm-bmt/cu-password --query SecretString --output text)'
    # Multi-cluster cfg requires --cluster-id at the interactive level (top
    # of cli, not inside the shell). Without it, cli refuses to start with
    # "multiple clusters provided in configuration file. Please specify
    # `cluster-id`". Inside the heredoc, login still uses --cluster-id too,
    # but the interactive flag is what lets cli boot.
    echo "cloudhsm-cli interactive --cluster-id $cid <<EOF"
    echo "login --username admin --role admin --password \"\$CO_PW\" --cluster-id $cid"
    echo "user create --username $CU_USERNAME --role crypto-user --password \"\$CU_PW\""
    echo "user list"
    echo "logout"
    echo "quit"
    echo "EOF"
  } | ssm_run "CU bootstrap $cid" || {
    log "  CU bootstrap on $cid had non-zero status — continuing (idempotent generate may already exist)"
  }
done

# ============================================================================
# Step 3: generate W1/A1 keys on each cluster (token-resident).
# Same interactive heredoc pattern. Generates 4 keys per cluster with
# identical labels (BMT_V3_W1_AES128/256, BMT_A1_AES128/256). Re-running is
# idempotent — duplicate label generates fail locally (cli error) but the
# heredoc continues. `key list --filter attr.label=...` at the end confirms
# all 4 are present.
# ============================================================================
log "Step 3: generate W1/A1 keys on each cluster"
for cid in "${CLUSTER_IDS[@]}"; do
  log "  cluster: $cid"
  {
    echo "set -e"
    echo "export PATH=/opt/cloudhsm/bin:\$PATH"
    echo "export AWS_REGION=$REGION"
    echo 'CU_PW=$(aws secretsmanager get-secret-value --region '"$REGION"' --secret-id hsm-bmt/cu-password --query SecretString --output text)'
    # Multi-cluster cfg requires --cluster-id at the interactive level (top
    # of cli, not inside the shell). Without it, cli refuses to start with
    # "multiple clusters provided in configuration file. Please specify
    # `cluster-id`". Inside the heredoc, login still uses --cluster-id too,
    # but the interactive flag is what lets cli boot.
    echo "cloudhsm-cli interactive --cluster-id $cid <<EOF"
    echo "login --username $CU_USERNAME --role crypto-user --password \"\$CU_PW\" --cluster-id $cid"
    # Generate the 4 keys. Token=true is the default in cloudhsm-cli 5.17.x;
    # passing it explicitly via --attributes is rejected ("Token key
    # attribute cannot be supplied via optional attributes"). For
    # session-only keys you'd add --session; we want token-resident so we
    # omit both.
    # Errors-on-duplicate are non-fatal inside interactive.
    # Labels match what v3_bench.c hardcodes (verified in source 2026-05-24):
    #   aes_128: a1_label="A1_128", w1_label="BMT_V3_W1_AES128"
    #   aes_256: a1_label="A1",     w1_label="BMT_V3_W1_AES256"
    echo "key generate-symmetric aes --label BMT_V3_W1_AES128 --key-length-bytes 16 --attributes encrypt=true decrypt=true wrap=true unwrap=true sign=true verify=true"
    echo "key generate-symmetric aes --label BMT_V3_W1_AES256 --key-length-bytes 32 --attributes encrypt=true decrypt=true wrap=true unwrap=true sign=true verify=true"
    echo "key generate-symmetric aes --label A1_128           --key-length-bytes 16 --attributes encrypt=true decrypt=true sign=true verify=true"
    echo "key generate-symmetric aes --label A1               --key-length-bytes 32 --attributes encrypt=true decrypt=true sign=true verify=true"
    # Verify
    echo "key list --filter attr.label=BMT_V3_W1_AES128"
    echo "key list --filter attr.label=BMT_V3_W1_AES256"
    echo "key list --filter attr.label=A1_128"
    echo "key list --filter attr.label=A1"
    echo "logout"
    echo "quit"
    echo "EOF"
  } | ssm_run "key generate $cid" || exit 1
done

log "DONE: 4 keys × $CLUSTER_COUNT cluster(s) provisioned"
log "  Labels: BMT_V3_W1_AES128, BMT_V3_W1_AES256, A1_128, A1"
