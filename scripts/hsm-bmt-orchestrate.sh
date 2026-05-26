#!/usr/bin/env bash
# /usr/local/bin/hsm-bmt-orchestrate.sh
#
# BMT orchestrator entry point for the HARD-only scenarios. Reads
# /etc/hsm-bmt/runner.env (RUN_ID, HSM_BMT_RUNNER, HSM_BMT_PROCS,
# HSM_BMT_WORKER_COUNT, HSM_BMT_AUTO_SCALE, HSM_BMT_CLUSTER_SIZES,
# HSM_BMT_HARD_SCALE, ...) and dispatches to either:
#   - java-multiproc       : N concurrent BmtMain JVMs (legacy, retained for
#                            DDB row history. New scenarios are c-native.)
#   - c-native-multiproc   : N concurrent /tmp/per_call_bench processes
#
# 2026-05-25 HOS rewrite:
#   - HARD-only: SCALE_TOOL is always hard-scale-cluster.sh. soft scale
#     (toggling cfg enable=true|false) and V3 family (v3-bench-wrapper.sh)
#     are no longer reachable from the live scenario set.
#   - SIZES are parsed from HSM_BMT_CLUSTER_SIZES (csv, descending sort)
#     instead of being hardcoded to (6 5 4 3 2). Partial HARD (single
#     size, hardScale=true && autoScale=false) takes the single-pass branch.
#   - cluster-state SSM lock is checked at entry (belt-and-suspenders to
#     start-run lambda's check) and the orchestrator aborts cleanly if a
#     concurrent hard-scale operation is in progress.
#   - Auto-reset on success/FAILED/ABORTED is deprecated: when measurement
#     ends the cluster stays at whatever HSM count it ended at. The next
#     run's PreFlight will provision back up if needed.
#
# Marks DDB bmt-runs row RUNNING on entry, COMPLETED on success, FAILED
# on error.

set -uo pipefail
LOG=/var/log/hsm-bmt/orchestrate.log
mkdir -p /var/log/hsm-bmt
exec > >(tee -a "$LOG") 2>&1

# Load env first so we can include RUN_ID in lock-conflict messages.
set -a; . /etc/hsm-bmt/runner.env; set +a
: "${RUN_ID:?missing}"

# EC2-layer single-instance lock. Belt-and-suspenders to the DDB-layer
# bmt-runs-lock (which prevents *new* Run starts at the API). This guards
# against the case where SSM SendCommand fires twice for the same RUN_ID
# (transient SSM retry, operator double-invocation, systemd restart loop).
# `flock -n` returns immediately on contention; we exit 0 so the duplicate
# invocation is a clean no-op rather than a "FAILED" trap that would clobber
# the in-progress Run's status.
LOCK_FILE=/var/run/hsm-bmt-orchestrate.lock
mkdir -p /var/run
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  HOLDER=$(cat "$LOCK_FILE.runid" 2>/dev/null || echo unknown)
  echo "[$(date -u +%T)] orchestrate.sh already running (holder RUN_ID=$HOLDER); this invocation for RUN_ID=$RUN_ID exits 0"
  exit 0
fi
# Record which RUN_ID owns the lock (best-effort, for diagnostics on the
# next contention). The fd-200 lock is what actually enforces exclusion.
echo "$RUN_ID" > "$LOCK_FILE.runid"
# Note: no EXIT trap here for cleanup — flock auto-releases when the script
# exits (fd 200 closes), and the .runid file gets overwritten on next run.
# Adding an EXIT trap would shadow nothing today but would interact poorly
# if a future change adds an ERR-or-cleanup EXIT trap.
: "${EXPECTED_VERSION_ID:?missing}"
: "${EXPECTED_SHA256:?missing}"
: "${S3_BUCKET:?missing}"
: "${HSM_BMT_RUNNER:?missing}"
: "${HSM_BMT_PROCS:=1}"
: "${HSM_BMT_AUTO_SCALE:=0}"
: "${HSM_BMT_WORKER_COUNT:=}"
: "${HSM_BMT_CLUSTER_SIZES:=6}"
# c-native-multiproc family. Only PER_CALL_RAW is supported in HARD-only
# scenarios; V3 (v3-bench-wrapper.sh) is deprecated. Java path reads
# families from DDB matrixSubset and ignores this var.
: "${HSM_BMT_FAMILY:=PER_CALL_RAW}"

REGION=ap-northeast-2
TABLE_RUNS=bmt-runs
echo "[$(date -u +%T)] orchestrate start RUN_ID=$RUN_ID runner=$HSM_BMT_RUNNER procs=$HSM_BMT_PROCS autoScale=$HSM_BMT_AUTO_SCALE sizes=$HSM_BMT_CLUSTER_SIZES"

# 2026-05-25 HOS-Step3: belt-and-suspenders cluster-state check. start-run
# lambda already rejects new runs while cluster-state=scaling, but a stale
# SSM SendCommand or operator double-invocation could still land here. If
# scaling is in progress, abort cleanly without touching the lock or
# cluster — leave it to the in-flight scale operation.
cluster_state=$(aws ssm get-parameter --region "$REGION" \
  --name /hsm-bmt/core/cluster-state --query Parameter.Value --output text 2>/dev/null || echo idle)
if [ "$cluster_state" = "scaling" ]; then
  echo "[$(date -u +%T)] cluster-state=scaling — orchestrate aborting (no measurement, no reset)"
  aws dynamodb update-item --region "$REGION" --table-name "$TABLE_RUNS" \
    --key "{\"runId\":{\"S\":\"$RUN_ID\"}}" \
    --update-expression "SET #s = :s, completedAt = :ca" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":s\":{\"S\":\"FAILED\"},\":ca\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"}}" \
    >/dev/null 2>&1 || true
  aws dynamodb update-item --region "$REGION" --table-name bmt-runs-lock \
    --key '{"key":{"S":"global"}}' \
    --update-expression "SET activeRunId = :empty" \
    --condition-expression "activeRunId = :rid" \
    --expression-attribute-values "{\":empty\":{\"S\":\"\"},\":rid\":{\"S\":\"$RUN_ID\"}}" \
    >/dev/null 2>&1 || true
  exit 0
fi

# We mark the bmt-runs row RUNNING/COMPLETED ourselves so the row only flips
# COMPLETED once ALL N JVMs (java-multiproc) or all 4 cells × N procs
# (c-native-multiproc) actually finish. JVMs receive
# HSM_BMT_SKIP_RUN_STATUS=1 via the systemd template (Environment= line) so
# Java's MeasurementOrchestrator skips its own publishRunStarted/Completed.
export HSM_BMT_SKIP_RUN_STATUS=1

# Make sure loader.jar matches the expected sha (java paths share this jar)
if [ "$HSM_BMT_RUNNER" != "c-native-multiproc" ]; then
  /usr/local/bin/hsm-bmt-verify-binary.sh
fi

set_run_status() {
  local status="$1"
  local extra="$2"  # additional UpdateExpression fragment, e.g. ", completedUnits = :c"
  local extra_vals="$3"  # JSON snippet for additional :vals
  # 2026-05-23: also stamp completedAt for terminal states so the live page
  # can show "종료 (UTC)" instead of indefinite "계산 중…".
  local terminal_extra=""
  local terminal_vals=""
  case "$status" in
    COMPLETED|ABORTED|FAILED)
      terminal_extra=", completedAt = :ca"
      terminal_vals=",\":ca\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"}"
      ;;
  esac
  aws dynamodb update-item --region "$REGION" --table-name "$TABLE_RUNS" \
    --key "{\"runId\":{\"S\":\"$RUN_ID\"}}" \
    --update-expression "SET #s = :s${extra}${terminal_extra}" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":s\":{\"S\":\"$status\"}${extra_vals}${terminal_vals}}" \
    >/dev/null
}

# U-CH-2 / COMP-CH-MOD-4: release the Run-level concurrency lock when this
# run finishes (either COMPLETED or via the ERR trap). The conditional only
# zeros activeRunId when it equals THIS run's RUN_ID, so:
#   - if abort-run already released the lock: ConditionalCheckFailedException
#     → swallowed by `|| true`
#   - if the lock was never acquired (ad-hoc bash run with no web-api):
#     ConditionalCheckFailedException → swallowed
#   - if a different RUN_ID held the lock: silent no-op (we do not stomp
#     someone else's lock)
release_run_lock() {
  aws dynamodb update-item --region "$REGION" --table-name bmt-runs-lock \
    --key '{"key":{"S":"global"}}' \
    --update-expression "SET activeRunId = :empty" \
    --condition-expression "activeRunId = :rid" \
    --expression-attribute-values "{\":empty\":{\"S\":\"\"},\":rid\":{\"S\":\"$RUN_ID\"}}" \
    >/dev/null 2>&1 || true
  echo "[$(date -u +%T)] release_run_lock RUN_ID=$RUN_ID (best-effort, conditional)"
}

# 2026-05-25 HOS-Step14: auto-reset is deprecated. Cluster stays at the size
# it ended at (success / FAILED / ABORTED). The next run's PreFlight checks
# requiredStartHsmCount and prompts the operator to provision if needed.
# This trades 25~100 min of reset overhead per run for one explicit
# operator click when the next run needs a different cluster size.
trap 'set_run_status FAILED "" ""; release_run_lock; echo "[$(date -u +%T)] FAILED"' ERR
set_run_status RUNNING "" ""

# Abort signal — SSM Parameter `/hsm-bmt/runs/{runId}/abort` set to "true"
# by abort-run lambda. orchestrate.sh polls this between cells / cluster
# transitions so a UI abort actually stops in-flight work (previously the
# Param was written but no one read it, so wrappers ran to completion —
# observed 2026-05-23 incident where progress kept climbing on an ABORTED
# run).
ABORT_PARAM="/hsm-bmt/runs/${RUN_ID}/abort"
# Reset any stale "true" left from a previous run with the same RUN_ID
# (defensive — RUN_IDs are timestamped, collision unlikely).
aws ssm put-parameter --region "$REGION" \
  --name "$ABORT_PARAM" --value "false" --type String --overwrite \
  >/dev/null 2>&1 || true

abort_requested() {
  # Returns 0 if abort flag is "true". Best-effort — on transient SSM
  # failure we treat as not-aborted and continue (next poll will catch).
  local val
  val=$(aws ssm get-parameter --region "$REGION" --name "$ABORT_PARAM" \
        --query 'Parameter.Value' --output text 2>/dev/null) || return 1
  [ "$val" = "true" ]
}

# Cooperative abort handler: kill all child bench processes, mark ABORTED,
# release lock, exit cleanly. Called from the cluster-loop and from the
# trap below so partial cell work stops within ~1 cooldown poll interval.
abort_now() {
  echo "[$(date -u +%T)] ABORT detected for RUN_ID=$RUN_ID — killing children"
  # Phase C: kill tracked children directly so their EXIT traps run
  # immediately (e.g. hard-scale-cluster.sh's cluster-state=idle release).
  if [ -n "$SCALE_TOOL_PID" ]; then
    echo "[$(date -u +%T)]   SIGTERM SCALE_TOOL pid=$SCALE_TOOL_PID"
    kill -TERM "$SCALE_TOOL_PID" 2>/dev/null || true
  fi
  if [ -n "$WRAPPER_PID" ]; then
    echo "[$(date -u +%T)]   SIGTERM WRAPPER pid=$WRAPPER_PID"
    kill -TERM "$WRAPPER_PID" 2>/dev/null || true
  fi
  # Belt-and-suspenders for any grandchildren.
  pkill -P $$ 2>/dev/null || true
  pkill -f "per_call_bench" 2>/dev/null || true   # matches /tmp/ and /usr/local/bin/
  pkill -f "v3_bench" 2>/dev/null || true
  pkill -f "per-call-bench-wrapper.sh" 2>/dev/null || true
  pkill -f "v3-bench-wrapper.sh" 2>/dev/null || true
  pkill -f "hard-scale-cluster.sh" 2>/dev/null || true
  # Give EXIT traps ~1s to fire (in particular, hard-scale-cluster.sh's
  # cluster-state=idle SSM put-parameter).
  sleep 1
  set_run_status ABORTED "" ""
  release_run_lock
  trap - ERR
  echo "[$(date -u +%T)] orchestrate aborted"
  exit 0
}

# Also respond to SIGTERM (so abort-run lambda can SendCommand
# `pkill -TERM -f hsm-bmt-orchestrate.sh` for an instant stop on top of
# the polling path).
trap 'abort_now' SIGTERM SIGINT

# 2026-05-25 HOS: HARD-only — scale tool is always hard-scale-cluster.sh
# (real cloudhsmv2 DeleteHsm/CreateHsm). Soft scale-cluster.sh path retired.
SCALE_TOOL="/usr/local/bin/hard-scale-cluster.sh"
echo "[$(date -u +%T)] SCALE_TOOL=$SCALE_TOOL (HARD scale, cloudhsmv2 DeleteHsm/CreateHsm)"

# Defense-in-depth gate: re-verify ACTIVE HSM count matches target after the
# scale tool returns, before launching the bench wrapper. hard-scale-cluster.sh
# already enforces its own invariant + IP set match; this catches the orthogonal
# class of failure (someone manual delete-hsm'd between the script's gate and
# the bench launch). Only runs for HARD scale path — soft scale-cluster.sh
# does not change the cluster's ACTIVE HSM count (it toggles cfg enable=true|
# false; cluster stays at desired-hsm-count = 6), so this gate would always
# fail there. Exits non-zero on mismatch → ERR trap → FAILED + reset.
verify_cluster_size() {
  local target="$1"
  if [ "${HSM_BMT_HARD_SCALE:-0}" != "1" ]; then
    return 0  # soft scale path: cluster ACTIVE count is decoupled from cfg
  fi
  local cid
  cid=$(aws ssm get-parameter --region "$REGION" \
    --name /hsm-bmt/core/cluster-id --query Parameter.Value --output text 2>/dev/null) || cid=""
  if [ -z "$cid" ] || [ "$cid" = "None" ]; then
    echo "[$(date -u +%T)] verify_cluster_size: cluster-id SSM param missing — skip gate"
    return 0
  fi
  local active
  active=$(aws cloudhsmv2 describe-clusters --region "$REGION" \
    --filters "clusterIds=$cid" \
    --query 'Clusters[0].Hsms[?State==`ACTIVE`] | length(@)' --output text 2>/dev/null)
  if [ "$active" != "$target" ]; then
    echo "[$(date -u +%T)] FATAL: orchestrator gate — cluster has $active ACTIVE HSMs but bench expects $target" >&2
    return 1
  fi
  echo "[$(date -u +%T)] orchestrator gate OK: $active ACTIVE HSMs == target $target"
  return 0
}

# 2026-05-26 (Phase B): probe current ACTIVE HSM count without taking any
# lock. Used by run_pass_* to decide whether SCALE_TOOL is needed at all.
# Echo the integer count, or 0 on any failure.
current_active_hsms() {
  local cid
  cid=$(aws ssm get-parameter --region "$REGION" \
    --name /hsm-bmt/core/cluster-id --query Parameter.Value --output text 2>/dev/null) || cid=""
  if [ -z "$cid" ] || [ "$cid" = "None" ]; then
    echo 0
    return
  fi
  aws cloudhsmv2 describe-clusters --region "$REGION" \
    --filters "clusterIds=$cid" \
    --query 'Clusters[0].Hsms[?State==`ACTIVE`] | length(@)' --output text 2>/dev/null \
    || echo 0
}

# 2026-05-26 (Phase C): tracked PIDs of long-running children. abort_now()
# kills these directly so a SIGTERM during `wait` interrupts immediately
# instead of queueing behind a 5-min mesh-stabilize sleep.
SCALE_TOOL_PID=""
WRAPPER_PID=""

# Helper: run "$@" in background, track its PID, wait, then clear the slot.
# Returns the child's exit status. The PID variable name is passed as $1
# (one of SCALE_TOOL_PID / WRAPPER_PID) so abort_now can target it.
run_tracked() {
  local pid_var="$1"; shift
  "$@" &
  local pid=$!
  # Assign to the named variable (eval is OK here — pid_var is hardcoded
  # at call sites, not user input)
  eval "$pid_var=$pid"
  local rc=0
  wait "$pid" || rc=$?
  eval "$pid_var=\"\""
  return $rc
}

run_pass_java_multiproc() {
  local size="$1"
  echo "[$(date -u +%T)] java-multiproc pass cluster=$size procs=$HSM_BMT_PROCS"
  # Phase B: skip SCALE_TOOL when cluster is already at target (avoids the
  # cluster-state lock entirely for the common case).
  local current
  current=$(current_active_hsms)
  if [ "$current" -eq "$size" ]; then
    echo "[$(date -u +%T)] cluster already at $size — skipping SCALE_TOOL"
  else
    # Phase C: tracked-PID + wait so a SIGTERM during the 300s mesh
    # stabilize sleep is delivered to hard-scale-cluster.sh directly.
    run_tracked SCALE_TOOL_PID "$SCALE_TOOL" "$size" || exit $?
  fi
  verify_cluster_size "$size" || exit 1

  # Stop any previous instances
  for i in $(seq 0 15); do
    systemctl stop "hsm-bmt-runner@${i}.service" 2>/dev/null || true
  done

  # Each JVM gets its own RUN_ID-scoped suffix so DDB rows don't collide.
  # Java BmtMain writes bmt-units rows under its own RUN_ID, but we want a
  # single bmt-runs row for the whole orchestration. Workaround: use the
  # SAME RUN_ID for every JVM — they will all write into bmt-units
  # concurrently. unitId already encodes (family, algo, mode, payload,
  # clusterSize, variant) so duplicate rows are possible only if two JVMs
  # complete the same cell. With identical cell sets (no sharding) we DO
  # see duplicates, but the loader's StatusReporter uses overwriting
  # PutItem so the last writer wins (semantically OK for a saturation
  # measurement: the tx counts are aggregated process-internally, the
  # ops/s in the row is one process's rate, multiplied by N at report time).
  for i in $(seq 0 $((HSM_BMT_PROCS - 1))); do
    # U-CH-4: HSM_BMT_PROCESS_IDX is read by BmtMain to label OTel
    # resource attrs (service.instance.id, tsp.process_idx), parquet S3
    # key (proc={idx}/), and DDB bmt-units sort key ({unitId}#proc{idx})
    # so multi-proc rows do not collide.
    cat > /etc/hsm-bmt/runner-${i}.env <<EOF
RUN_ID=$RUN_ID
EXPECTED_VERSION_ID=$EXPECTED_VERSION_ID
EXPECTED_SHA256=$EXPECTED_SHA256
S3_BUCKET=$S3_BUCKET
HSM_BMT_WORKER_COUNT=${HSM_BMT_WORKER_COUNT:-64}
HSM_BMT_PROCESS_IDX=${i}
EOF
    chown hsmbmt:hsmbmt /etc/hsm-bmt/runner-${i}.env
    chmod 0640 /etc/hsm-bmt/runner-${i}.env
    touch /var/log/hsm-bmt/loader-${i}.log
    chown hsmbmt:hsmbmt /var/log/hsm-bmt/loader-${i}.log
  done
  systemctl daemon-reload
  for i in $(seq 0 $((HSM_BMT_PROCS - 1))); do
    systemctl start "hsm-bmt-runner@${i}.service"
  done

  # Wait for all instances to finish (Restart=no, Type=simple → service
  # transitions inactive when JVM exits).
  echo "[$(date -u +%T)] waiting for ${HSM_BMT_PROCS} JVMs to finish..."
  while :; do
    local active=0
    for i in $(seq 0 $((HSM_BMT_PROCS - 1))); do
      if [ "$(systemctl is-active hsm-bmt-runner@${i}.service)" = "active" ]; then
        active=$((active + 1))
      fi
    done
    [ "$active" = "0" ] && break
    sleep 30
  done
  echo "[$(date -u +%T)] java-multiproc pass cluster=$size complete"
}

run_pass_c_native() {
  local size="$1"
  echo "[$(date -u +%T)] c-native-multiproc pass cluster=$size procs=$HSM_BMT_PROCS family=${HSM_BMT_FAMILY:-PER_CALL_RAW}"
  # Phase B: skip SCALE_TOOL when already at target.
  local current
  current=$(current_active_hsms)
  if [ "$current" -eq "$size" ]; then
    echo "[$(date -u +%T)] cluster already at $size — skipping SCALE_TOOL"
  else
    # Phase C: tracked-PID + wait for SIGTERM interrupt-ability.
    run_tracked SCALE_TOOL_PID "$SCALE_TOOL" "$size" || exit $?
  fi
  verify_cluster_size "$size" || exit 1
  # 2026-05-25 HOS: HARD-only scenarios use PER_CALL_RAW only. V3 family
  # (v3-bench-wrapper.sh) is retired.
  case "${HSM_BMT_FAMILY:-PER_CALL_RAW}" in
    PER_CALL_RAW)
      run_tracked WRAPPER_PID /usr/local/bin/per-call-bench-wrapper.sh "$size" \
        || exit $?
      ;;
    *) echo "Unknown / retired HSM_BMT_FAMILY for c-native: ${HSM_BMT_FAMILY:-unset}"; exit 2 ;;
  esac
  echo "[$(date -u +%T)] c-native-multiproc pass cluster=$size complete"
}

# HSM-adaptive procs lookup. PER_CALL Full sweep encodes its sweet-spot
# proc-per-cluster mapping in HSM_BMT_PROCS_BY_CLUSTER (e.g.
# "6:12,5:12,4:10,3:8,2:6"). Returns the procs override for the given size,
# or an empty string if the env is unset / the size is not present.
# Source: 5/19 cluster-sat-results.csv saturation sweep.
lookup_procs_by_cluster() {
  local size="$1"
  local map="${HSM_BMT_PROCS_BY_CLUSTER:-}"
  [ -z "$map" ] && return 0
  # split comma-list, find matching size
  local entry
  IFS=',' read -ra ENTRIES <<< "$map"
  for entry in "${ENTRIES[@]}"; do
    case "$entry" in
      "$size":*) echo "${entry#*:}"; return 0 ;;
    esac
  done
}

run_pass() {
  local size="$1"
  # HSM-adaptive procs: if procsByCluster has an entry for this size, use it
  # (override the static HSM_BMT_PROCS). Else use the static value as-is.
  local override
  override=$(lookup_procs_by_cluster "$size")
  if [ -n "$override" ]; then
    echo "[$(date -u +%T)] HSM-adaptive procs: cluster=$size → procs=$override (was $HSM_BMT_PROCS)"
    export HSM_BMT_PROCS="$override"
  fi
  case "$HSM_BMT_RUNNER" in
    java-multiproc)     run_pass_java_multiproc "$size" ;;
    c-native-multiproc) run_pass_c_native "$size" ;;
    *) echo "Unknown runner: $HSM_BMT_RUNNER"; exit 2 ;;
  esac
}

# Main loop. Between cluster-size passes the orchestrator waits for a
# 5-minute cool-down so HSM cluster-mesh state and TCP/mTLS pools settle
# before the next size's measurement begins. Override via HSM_BMT_COOLDOWN_S
# (seconds) if needed for ad-hoc runs.
COOLDOWN_S="${HSM_BMT_COOLDOWN_S:-300}"

# 2026-05-25 HOS: SIZES come from HSM_BMT_CLUSTER_SIZES (csv) instead of
# being hardcoded. autoScale=true sweeps the list (descending) with size
# cool-down between passes. autoScale=false runs a single pass at the
# first size (= sizes[0]). Multi-cluster (us-west-2) and V3 paths are
# retired; the legacy AUTO_SCALE_CLUSTERS branch has been removed.
IFS=',' read -ra _SIZES_INPUT <<< "$HSM_BMT_CLUSTER_SIZES"
# Sort descending — largest size first so we scale DOWN through the sweep.
SIZES=( $(printf '%s\n' "${_SIZES_INPUT[@]}" | sort -nr) )
echo "[$(date -u +%T)] sweep sizes=${SIZES[*]} (autoScale=$HSM_BMT_AUTO_SCALE)"

if [ "$HSM_BMT_AUTO_SCALE" = "1" ]; then
  last_idx=$((${#SIZES[@]} - 1))
  for idx in "${!SIZES[@]}"; do
    size="${SIZES[$idx]}"
    abort_requested && abort_now
    run_pass "$size"
    abort_requested && abort_now
    if [ "$idx" -lt "$last_idx" ]; then
      echo "[$(date -u +%T)] cool-down ${COOLDOWN_S}s before next cluster size"
      # Cool-down sleep that wakes early on abort: poll every 10 s.
      slept=0
      while [ "$slept" -lt "$COOLDOWN_S" ]; do
        abort_requested && abort_now
        sleep 10
        slept=$((slept + 10))
      done
    fi
  done
else
  # Single-pass mode (Smoke / Partial HARD / Custom HARD with single size).
  # SCALE_TOOL is invoked once for the chosen size; if cluster is already at
  # that size, hard-scale-cluster.sh is a no-op (cfg refresh + stabilize).
  size="${SIZES[0]}"
  abort_requested && abort_now
  run_pass "$size"
fi

# 2026-05-25 HOS-Step14: success path no longer resets the cluster. Whatever
# size the sweep ended at (e.g. cs=2 after a Full HARD) is the size the
# cluster stays at. The next run's PreFlight will check requiredStartHsmCount
# vs current ACTIVE and prompt the operator to provision back up if needed.
#
# Mark COMPLETED. DDB row's completedUnits/totalUnits is updated by the
# wrapper (per-call-bench-wrapper.sh / java path).
set_run_status COMPLETED "" ""
release_run_lock
trap - ERR
echo "[$(date -u +%T)] orchestrate done — cluster left at cs=${SIZES[-1]} (auto-reset disabled)"
