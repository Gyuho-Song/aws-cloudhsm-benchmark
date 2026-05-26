#!/usr/bin/env bash
# /usr/local/bin/hard-scale-cluster.sh <N|reset>
#
# HARD scale the CloudHSM cluster: actually delete-hsm / create-hsm to change
# the cluster's HSM count. Distinct from soft scale-cluster.sh which only
# toggles the loader-side enable=true|false (cluster mesh stays at 6 HSMs).
#
# Why both: 2026-05-24 measurement showed soft cs=2 = 1,941 tx/s but hard
# cs=2 (real 2-HSM cluster) = ~1,354 tx/s on the same axis. The mesh size
# itself affects throughput — production HSM-fail scenarios match the
# hard path, not the soft path. Reports based on soft-scale data over-
# estimate cs<6 throughput.
#
# Usage:
#   hard-scale-cluster.sh <N>    # 2..6 — actually move HSM count to N
#   hard-scale-cluster.sh reset  # restore to 6 (or whatever
#                                 # /hsm-bmt/core/desired-hsm-count says)
#
# Inputs (SSM):
#   /hsm-bmt/core/cluster-id
#   /hsm-bmt/core/hsm-slots             (JSON; AZ allocation table)
#   /hsm-bmt/core/desired-hsm-count     (reset target, default 6)
#
# Side-effects per pass:
#   - cloudhsmv2:DeleteHsm or CreateHsm calls (reversible)
#   - /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg rewritten via configure-pkcs11
#     + jq patch type=hsm2m
#   - Stabilize sleep (60s default) so mesh / mTLS pool reaches steady state
#
# Time:
#   - Scale-down 1 HSM: ~10–15 min  (cloudhsmv2:DeleteHsm + propagation)
#   - Scale-up   1 HSM: ~25 min     (cloudhsmv2:CreateHsm + activation)
#   So 6→2 (4 deletes) ≈ 60 min; 2→6 (4 creates) ≈ 100 min.
#
# Idempotent. Logs to /var/log/hsm-bmt/hard-scale-cluster.log
#
# 2026-05-25: switched list_active query from dict form
#   {Id:HsmId,AZ:AvailabilityZone,IP:EniIp}
# (which serializes to text in alphabetical KEY order — AZ, Id, IP — so
# `awk '{print $1}'` picked the AZ string and the script ran
# `delete-hsm ap-northeast-2d` against an invalid HSM id) to array form
#   [HsmId,AvailabilityZone,EniIp]
# which preserves declaration order. Also added `set -e` so AccessDenied or
# any non-zero CLI exit hard-fails instead of silently skipping the wait.
set -euo pipefail
REGION=${AWS_REGION:-ap-northeast-2}
LOG=/var/log/hsm-bmt/hard-scale-cluster.log
mkdir -p /var/log/hsm-bmt
exec > >(tee -a "$LOG") 2>&1

ARG=${1:-}
if [ -z "$ARG" ]; then echo "usage: $0 <N|reset>" >&2; exit 2; fi

# 2026-05-25 HOS-Step2: single-instance lock + cluster-state SSM lock.
# flock prevents two hard-scale-cluster.sh runs from racing on the same
# cluster (cfg refresh / mesh / DeleteHsm interleaving). cluster-state
# SSM is the authoritative lock that orchestrate.sh and start-run lambda
# check before launching a measurement.
LOCK_FILE=/var/run/hsm-bmt-hard-scale.lock
mkdir -p /var/run
exec 201>"$LOCK_FILE"
if ! flock -n 201; then
  echo "ERROR: another hard-scale-cluster.sh is already running (lock $LOCK_FILE held)" >&2
  exit 2
fi

# 2026-05-26: ORDER MATTERS. Three things must be true on EVERY exit path
# (success, set -e fail, SIGTERM, syntax error in a function definition):
#   1. cluster-state SSM is restored to 'idle' (otherwise UI gets stuck on
#      "scaling lock stale" and operator can't start the next run).
#   2. The 'cluster-state-target' SSM put doesn't reference $N before $N
#      is defined (set -u dies → trap not yet registered → idle never put).
#   3. The on_exit trap is registered BEFORE any aws ssm put that could
#      itself fail (e.g. transient API throttle).
# Hence: (a) parse $ARG → $N first, (b) register trap, (c) only THEN
# write the cluster-state=scaling lock + target. The 2026-05-26 incident
# at 06:20Z left scaling=stuck-for-284-min because steps were reversed:
# put-parameter --value "$N" hit set -u "N: unbound variable" before the
# trap was installed.

CLUSTER_ID=$(aws ssm get-parameter --region "$REGION" --name /hsm-bmt/core/cluster-id --query Parameter.Value --output text 2>/dev/null || echo "")
if [ -z "$CLUSTER_ID" ] || [ "$CLUSTER_ID" = "None" ]; then
  echo "ERROR: /hsm-bmt/core/cluster-id not set" >&2; exit 1
fi

DESIRED_TOTAL=$(aws ssm get-parameter --region "$REGION" --name /hsm-bmt/core/desired-hsm-count --query Parameter.Value --output text 2>/dev/null || echo 6)
SLOTS_JSON=$(aws ssm get-parameter --region "$REGION" --name /hsm-bmt/core/hsm-slots --query Parameter.Value --output text 2>/dev/null || echo "[]")

if [ "$ARG" = "reset" ]; then
  N=$DESIRED_TOTAL
else
  N=$ARG
  if ! [[ "$N" =~ ^[0-9]+$ ]] || [ "$N" -lt 2 ] || [ "$N" -gt "$DESIRED_TOTAL" ]; then
    echo "ERROR: N must be 2..$DESIRED_TOTAL (got $N)" >&2; exit 2
  fi
fi

# EXIT trap restores cluster-state=idle on any exit path (success, set -e
# fail, SIGINT, SIGTERM). Idempotent. Registered BEFORE the cluster-state
# put so even a put-parameter throttle / die leaves us with state=idle.
on_exit() {
  aws ssm put-parameter --region "$REGION" \
    --name /hsm-bmt/core/cluster-state --value idle --type String --overwrite \
    >/dev/null 2>&1 || true
  # cluster-state-since is left in place; cluster-status lambda only reads
  # it when state=='scaling' so a stale value is harmless during idle.
  echo "[$(date '+%H:%M:%S')] cluster-state=idle (lock released)"
}
trap on_exit EXIT

aws ssm put-parameter --region "$REGION" \
  --name /hsm-bmt/core/cluster-state --value scaling --type String --overwrite \
  >/dev/null 2>&1 || true
# 2026-05-26 (Phase E): record when scaling started so cluster-status
# lambda can detect a stale lock (>90 min old → uiState='stale').
aws ssm put-parameter --region "$REGION" \
  --name /hsm-bmt/core/cluster-state-since \
  --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type String --overwrite \
  >/dev/null 2>&1 || true
# 2026-05-26: record the target so cluster-status lambda can display the
# correct '<current> → <target>' transition (was showing the static
# desired-hsm-count, e.g. '5 → 6' during a 6→3 scale-down).
aws ssm put-parameter --region "$REGION" \
  --name /hsm-bmt/core/cluster-state-target \
  --value "$N" --type String --overwrite \
  >/dev/null 2>&1 || true
echo "[$(date '+%H:%M:%S')] cluster-state=scaling target=$N (lock acquired)"
echo "[$(date '+%H:%M:%S')] hard-scale target=$N (desired_total=$DESIRED_TOTAL)"

# --- helper: list current ACTIVE HSMs in cluster, sorted by HsmId for stable
# order so delete picks the same victim across reruns at the same target N.
# Output: tab-separated <HsmId> <AvailabilityZone> <EniIp> per line. Uses array
# form (not dict) so column order is the declaration order, not alphabetical
# key order. (Earlier dict form returned <AZ> <HsmId> <IP> and broke delete.)
list_active() {
  aws cloudhsmv2 describe-clusters --region "$REGION" \
    --filters "clusterIds=$CLUSTER_ID" \
    --query 'Clusters[0].Hsms[?State==`ACTIVE`].[HsmId,AvailabilityZone,EniIp]' \
    --output text | sort -k1,1
}

# --- helper: wait until a HSM transitions away from given state.
wait_until_gone() {
  local hsm_id=$1
  local timeout=${2:-1200}  # 20 min default
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local s
    s=$(aws cloudhsmv2 describe-clusters --region "$REGION" \
      --filters "clusterIds=$CLUSTER_ID" \
      --query "Clusters[0].Hsms[?HsmId=='$hsm_id'].State|[0]" \
      --output text 2>/dev/null)
    if [ "$s" = "None" ] || [ -z "$s" ]; then return 0; fi
    sleep 30
    elapsed=$((elapsed + 30))
    echo "[$(date '+%H:%M:%S')]   waiting for $hsm_id to disappear (state=$s, ${elapsed}s)"
  done
  echo "ERROR: timed out waiting for $hsm_id to delete" >&2
  return 1
}

# --- helper: wait until a HSM reaches ACTIVE.
wait_until_active() {
  local hsm_id=$1
  local timeout=${2:-1800}  # 30 min default
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local s
    s=$(aws cloudhsmv2 describe-clusters --region "$REGION" \
      --filters "clusterIds=$CLUSTER_ID" \
      --query "Clusters[0].Hsms[?HsmId=='$hsm_id'].State|[0]" \
      --output text 2>/dev/null)
    if [ "$s" = "ACTIVE" ]; then return 0; fi
    if [ "$s" = "DEGRADED" ] || [ "$s" = "DELETED" ]; then
      echo "ERROR: $hsm_id reached terminal state $s without becoming ACTIVE" >&2
      return 1
    fi
    sleep 30
    elapsed=$((elapsed + 30))
    echo "[$(date '+%H:%M:%S')]   waiting for $hsm_id ACTIVE (state=$s, ${elapsed}s)"
  done
  echo "ERROR: timed out waiting for $hsm_id to become ACTIVE" >&2
  return 1
}

# --- helper: pick AZ for new HSM. Distribute across AZs evenly relative to
# the current ACTIVE set. Falls back to slot table order if calculation fails.
#
# 2026-05-26: hsm-slots SSM contains LOGICAL AZ placeholders ('logical-az-1',
# 'logical-az-2', ...) — NOT real AZ names. cluster-create.sh maps logical →
# real on initial provisioning, but the slot SSM is never rewritten. We must
# do the same logical→real mapping here, otherwise CreateHsm receives e.g.
# 'logical-az-1' and rejects it (CloudHsmInvalidRequestException).
# Incident 11:25Z: cs=3→6 provision crashed at first CreateHsm with
# "Member must satisfy regular expression pattern: [a-z]{2}...".
pick_az_for_create() {
  # Build logical-az-N → real region AZ map (cached on first call).
  if [ -z "${REGION_AZS_CSV:-}" ]; then
    REGION_AZS_CSV=$(aws ec2 describe-availability-zones --region "$REGION" \
      --filters "Name=state,Values=available" \
      --query 'AvailabilityZones[].ZoneName' --output text | tr '\t' ',')
  fi
  IFS=',' read -r -a REGION_AZS <<< "$REGION_AZS_CSV"

  # Resolve a slot value (possibly 'logical-az-N') to the real AZ.
  resolve_az() {
    local v=$1
    case "$v" in
      logical-az-1) echo "${REGION_AZS[0]:-${REGION}a}" ;;
      logical-az-2) echo "${REGION_AZS[1]:-${REGION}b}" ;;
      logical-az-3) echo "${REGION_AZS[2]:-${REGION}c}" ;;
      logical-az-4) echo "${REGION_AZS[3]:-${REGION}d}" ;;
      *) echo "$v" ;;  # already a real AZ
    esac
  }

  # Count current ACTIVE HSMs per AZ (these are real AZ names).
  local az_count_csv
  az_count_csv=$(aws cloudhsmv2 describe-clusters --region "$REGION" \
    --filters "clusterIds=$CLUSTER_ID" \
    --query 'Clusters[0].Hsms[?State==`ACTIVE`].AvailabilityZone' \
    --output text | tr '\t' '\n' | sort | uniq -c | awk '{print $2":"$1}' | tr '\n' ',')

  # Find AZ with smallest count, mapping each slot's logical AZ to real.
  local best_az="" best_n=99
  for slot_logical_az in $(echo "$SLOTS_JSON" | jq -r '.[].az' 2>/dev/null | sort -u); do
    local slot_az
    slot_az=$(resolve_az "$slot_logical_az")
    local n=0
    for entry in $(echo "$az_count_csv" | tr ',' ' '); do
      local az_part=${entry%:*}
      local n_part=${entry#*:}
      if [ "$az_part" = "$slot_az" ]; then n=$n_part; break; fi
    done
    if [ "$n" -lt "$best_n" ]; then best_n=$n; best_az=$slot_az; fi
  done
  if [ -z "$best_az" ]; then
    # Fallback: first AZ in slot table (also resolved through logical→real).
    local first_logical
    first_logical=$(echo "$SLOTS_JSON" | jq -r '.[0].az' 2>/dev/null || echo "")
    best_az=$(resolve_az "${first_logical:-logical-az-1}")
    [ -z "$best_az" ] && best_az="${REGION}a"
  fi
  echo "$best_az"
}

# --- main scaling loop -----------------------------------------------------
# Safety net against runaway scale-up: process substitution doesn't propagate
# pipefail to set -e, so on list_active failure mapfile would silently see
# empty input, CURRENT=0, target N=5 → "scale-up: create 5 HSM(s)" against a
# cluster that's already at 6. We defensively re-query if the array is empty
# and bail before any CreateHsm call.
mapfile -t ACTIVE_HSMS < <(list_active | awk '{print $1}')
CURRENT=${#ACTIVE_HSMS[@]}
if [ "$CURRENT" -eq 0 ]; then
  echo "[$(date '+%H:%M:%S')] WARN: list_active returned 0 ACTIVE HSMs — re-checking via direct API"
  RAW=$(aws cloudhsmv2 describe-clusters --region "$REGION" --filters "clusterIds=$CLUSTER_ID" --output json)
  STATE=$(echo "$RAW" | jq -r '.Clusters[0].State // "UNKNOWN"')
  ALL=$(echo "$RAW" | jq -r '.Clusters[0].Hsms | length')
  echo "[$(date '+%H:%M:%S')] cluster state=$STATE total Hsms=$ALL"
  if [ "$ALL" -gt 0 ]; then
    echo "ERROR: cluster has $ALL HSMs but none ACTIVE (states: $(echo "$RAW" | jq -r '.Clusters[0].Hsms[].State' | tr '\n' ',')) — refusing to scale" >&2
    exit 1
  fi
fi
echo "[$(date '+%H:%M:%S')] current ACTIVE: $CURRENT (${ACTIVE_HSMS[*]:-none})"

if [ "$CURRENT" -eq "$N" ]; then
  # 2026-05-26: fast-noop. If the cluster is already at the target size,
  # there's nothing to scale. We still verify the loader cfg is consistent
  # (catches the case where someone manually edited cfg), but skip the
  # 300s mesh stabilize wait — there was no mesh change to settle. This
  # turns an accidental "provision to current size" click from a 5-minute
  # lock into a ~3-second sanity check.
  echo "[$(date '+%H:%M:%S')] already at target N=$N — verifying cfg, skipping stabilize"
  CFG_N=$(jq '.clusters[0].cluster.servers | length' /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg 2>/dev/null || echo 0)
  if [ "$CFG_N" -ne "$N" ]; then
    # cfg is out of sync — fall through to the full refresh path below.
    echo "[$(date '+%H:%M:%S')] cfg mismatch (got $CFG_N, want $N) — full refresh required"
  else
    # IP set sanity check
    ACTIVE_IPS=$(aws cloudhsmv2 describe-clusters --region "$REGION" \
      --filters "clusterIds=$CLUSTER_ID" \
      --query 'Clusters[0].Hsms[?State==`ACTIVE`].EniIp' --output text | tr '\t' '\n' | sort -u)
    CFG_IPS=$(jq -r '.clusters[0].cluster.servers[].hostname' /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg | sort -u)
    if [ "$ACTIVE_IPS" = "$CFG_IPS" ]; then
      echo "[$(date '+%H:%M:%S')] FAST-NOOP OK target=$N active=$CURRENT cfg=$CFG_N (IPs match)"
      echo "[$(date '+%H:%M:%S')] hard-scale done at N=$N (no-op)"
      exit 0
    fi
    echo "[$(date '+%H:%M:%S')] IP set mismatch — full refresh required"
  fi
elif [ "$CURRENT" -gt "$N" ]; then
  # Scale-DOWN: delete (CURRENT - N) HSMs, picking the LAST in sorted order
  TO_DELETE=$((CURRENT - N))
  echo "[$(date '+%H:%M:%S')] scale-down: delete $TO_DELETE HSM(s)"
  for ((k=0; k<TO_DELETE; k++)); do
    # Pop the last HSM
    VICTIM=${ACTIVE_HSMS[-1]}
    unset 'ACTIVE_HSMS[-1]'
    echo "[$(date '+%H:%M:%S')]   delete-hsm $VICTIM"
    aws cloudhsmv2 delete-hsm --region "$REGION" --cluster-id "$CLUSTER_ID" \
      --hsm-id "$VICTIM" --query 'HsmId' --output text > /dev/null
    wait_until_gone "$VICTIM" || exit 1
  done
elif [ "$CURRENT" -lt "$N" ]; then
  # Scale-UP: create (N - CURRENT) HSMs in AZ-balanced fashion
  TO_CREATE=$((N - CURRENT))
  echo "[$(date '+%H:%M:%S')] scale-up: create $TO_CREATE HSM(s)"
  for ((k=0; k<TO_CREATE; k++)); do
    AZ=$(pick_az_for_create)
    echo "[$(date '+%H:%M:%S')]   create-hsm in $AZ"
    NEW=$(aws cloudhsmv2 create-hsm --region "$REGION" --cluster-id "$CLUSTER_ID" \
      --availability-zone "$AZ" --query 'Hsm.HsmId' --output text)
    echo "[$(date '+%H:%M:%S')]     HsmId: $NEW"
    wait_until_active "$NEW" || exit 1
  done
fi

# --- refresh loader pkcs11 cfg with verify-and-retry ---------------------
# 2026-05-25: configure-pkcs11 occasionally lags AWS control plane (cfg
# server count != actual ACTIVE HSM count) for tens of seconds after
# delete-hsm/create-hsm, especially right after a CreateHsm settles. The
# previous code WARN'd and continued, leaving bench to run against a stale
# cfg. Now retry up to 3 × 30s and hard-fail on persistent mismatch.
refresh_pkcs11_cfg() {
  /opt/cloudhsm/bin/configure-pkcs11 --cluster-id "$CLUSTER_ID" --region "$REGION" \
    --hsm-ca-cert /opt/cloudhsm/etc/customerCA.crt 2>&1 \
    || /opt/cloudhsm/bin/configure-pkcs11 --cluster-id "$CLUSTER_ID" --region "$REGION" 2>&1
  # Force type=hsm2m (configure-pkcs11 writes hsm1 by default in 5.17.x)
  jq '(.clusters[].type) = "hsm2m"' /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg > /tmp/p.json \
    && cp /tmp/p.json /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg
}

CFG_N=0
attempt=0
max_attempts=3
while [ "$attempt" -lt "$max_attempts" ]; do
  echo "[$(date '+%H:%M:%S')] refresh /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg (attempt $((attempt+1))/$max_attempts)"
  refresh_pkcs11_cfg
  CFG_N=$(jq '.clusters[0].cluster.servers | length' /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg 2>/dev/null || echo 0)
  if [ "$CFG_N" -eq "$N" ]; then
    echo "[$(date '+%H:%M:%S')] cfg has $CFG_N servers (matches target $N)"
    break
  fi
  attempt=$((attempt+1))
  echo "[$(date '+%H:%M:%S')] cfg mismatch (got $CFG_N want $N) — sleeping 30s before retry"
  sleep 30
done
if [ "$CFG_N" -ne "$N" ]; then
  echo "ERROR: pkcs11 cfg still has $CFG_N servers after $max_attempts attempts (target $N)" >&2
  exit 1
fi

# --- also refresh cli/jce cfg if present (best-effort, type-only patch) --
for f in /opt/cloudhsm/etc/cloudhsm-cli.cfg /opt/cloudhsm/etc/cloudhsm-jce.cfg; do
  [ -f "$f" ] || continue
  echo "[$(date '+%H:%M:%S')]   patch $f"
  jq '(.clusters[].type) = "hsm2m"' "$f" > /tmp/c.json && cp /tmp/c.json "$f" || true
done

# --- mesh stabilize wait ---------------------------------------------------
# 2026-05-25: default 60s → 300s. cluster mesh + mTLS pool needs longer
# than 60s to fully settle after a CreateHsm; bench runs starting too early
# saw transient elevated p99 + HL001 throttle bursts. 5 min matches the
# inter-cell cool-down baseline used elsewhere in the BMT pipeline.
STABILIZE_S=${HSM_BMT_HARD_SCALE_STABILIZE_S:-300}
echo "[$(date '+%H:%M:%S')] mesh stabilize wait ${STABILIZE_S}s"
sleep "$STABILIZE_S"

# --- post-stabilize invariant gate ---------------------------------------
# Final pre-bench check: actual ACTIVE HSM count, cfg server count, and
# the IP set seen by AWS == the IP set the loader will connect to. Any
# divergence here means the next 20-cell measurement would run against a
# different cluster than expected, so we hard-fail and let orchestrate.sh
# mark the run FAILED and trigger the async reset.
ACTIVE_NOW=$(aws cloudhsmv2 describe-clusters --region "$REGION" \
  --filters "clusterIds=$CLUSTER_ID" \
  --query 'Clusters[0].Hsms[?State==`ACTIVE`] | length(@)' --output text)
CFG_N=$(jq '.clusters[0].cluster.servers | length' /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg 2>/dev/null || echo 0)
if [ "$ACTIVE_NOW" -ne "$N" ] || [ "$CFG_N" -ne "$N" ]; then
  echo "ERROR: post-stabilize invariant violated (active=$ACTIVE_NOW cfg=$CFG_N target=$N)" >&2
  exit 1
fi

ACTIVE_IPS=$(aws cloudhsmv2 describe-clusters --region "$REGION" \
  --filters "clusterIds=$CLUSTER_ID" \
  --query 'Clusters[0].Hsms[?State==`ACTIVE`].EniIp' --output text | tr '\t' '\n' | sort -u)
CFG_IPS=$(jq -r '.clusters[0].cluster.servers[].hostname' /opt/cloudhsm/etc/cloudhsm-pkcs11.cfg | sort -u)
if [ "$ACTIVE_IPS" != "$CFG_IPS" ]; then
  echo "ERROR: HSM IP set mismatch between cluster and cfg (target $N)" >&2
  echo "cluster ACTIVE IPs:" >&2; echo "$ACTIVE_IPS" >&2
  echo "cfg server IPs:    " >&2; echo "$CFG_IPS" >&2
  exit 1
fi

echo "[$(date '+%H:%M:%S')] INVARIANT OK target=$N active=$ACTIVE_NOW cfg=$CFG_N (IPs match)"
echo "[$(date '+%H:%M:%S')] hard-scale done at N=$N"
