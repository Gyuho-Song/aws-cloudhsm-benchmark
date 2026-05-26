#!/usr/bin/env bash
# /usr/local/bin/per-call-bench-wrapper.sh <cluster_size>
#
# Drives /tmp/per_call_bench across the PER_CALL_RAW matrix:
#   (algo, mode, payload) ∈
#     {AES_128, AES_256} × {ECB, CBC, CTR, GCM, CMAC} × {256, 1024}
#     = 20 cells per cluster size.
#
# For each cell launches HSM_BMT_PROCS (default 4) per_call_bench processes
# in parallel, sums their tx_per_sec, writes one bmt-units row + one parquet
# under s3://$S3_BUCKET/runs/$RUN_ID/family=PER_CALL_RAW/unit={unitId}/result.parquet.
#
# Differential procs across payloads is supported via HSM_BMT_PROCS_256 /
# HSM_BMT_PROCS_1024 — small payloads can use higher fan-out (cluster has
# headroom), large payloads need fewer procs to stay inside the cell window
# (1024B mesh-replication is ~4x heavier than 256B).
#
# Output ordering matches v3-bench-wrapper.sh: cell-to-cell cool-down 30s
# (mesh+TCP/mTLS settle); cluster-size sweep cool-down 300s is handled by
# hsm-bmt-orchestrate.sh.

set -uo pipefail
SIZE="$1"
: "${RUN_ID:?missing}"
: "${S3_BUCKET:?missing}"
: "${HSM_BMT_PROCS:=4}"
: "${HSM_BMT_WORKER_COUNT:=64}"
REGION=ap-northeast-2

# Differential overrides — operator can set HSM_BMT_PROCS_256 / _1024 to
# tune fan-out per payload. Falls back to HSM_BMT_PROCS otherwise.
: "${HSM_BMT_PROCS_256:=$HSM_BMT_PROCS}"
: "${HSM_BMT_PROCS_1024:=$HSM_BMT_PROCS}"

PIN="bmt_cu:$(aws secretsmanager get-secret-value --region "$REGION" --secret-id hsm-bmt/cu-password --query SecretString --output text)"
export CLOUDHSM_PIN="$PIN"

# 2026-05-26: bench binary lives at /usr/local/bin/per_call_bench (persistent).
# The legacy path /tmp/per_call_bench was wiped on EC2 reboot (tmpfs); every
# cell ran in ~1s with ops=0 and the run looked "completed" but produced no
# data (incident 2026-05-26 03:33~03:46). For backwards-compat the wrapper
# falls through to /tmp/ if /usr/local/bin/ is missing, and auto-restores
# from S3 in either case.
BENCH=/usr/local/bin/per_call_bench
[ -x "$BENCH" ] || BENCH=/tmp/per_call_bench
if [ ! -x "$BENCH" ] || [ ! -s "$BENCH" ]; then
  echo "[$(date -u +%T)] $BENCH missing — restoring to /usr/local/bin/per_call_bench from S3"
  BENCH=/usr/local/bin/per_call_bench
  aws s3 cp "s3://$S3_BUCKET/loader-artifacts/per_call_bench-current" "$BENCH" --region "$REGION" --quiet \
    || { echo "[$(date -u +%T)] FATAL: bench restore failed" >&2; exit 3; }
  chmod +x "$BENCH"
fi
echo "[$(date -u +%T)] bench=$BENCH ($(stat -c %s "$BENCH") bytes)"

# Matrix axes — env-driven (HSM_BMT_ALGOS / _MODES / _PAYLOADS, comma-sep).
# start-run.ts always forwards the user's matrixSubset selection (empty string
# if no axis selected). 2026-05-26: removed the historical "full matrix"
# fallback defaults — they caused a Custom matrix run with zero axes selected
# to silently expand to all 20 cells. Now an unset/empty env reads to an
# empty array and the cell loop runs zero iterations.
IFS=',' read -r -a ALGOS    <<< "${HSM_BMT_ALGOS:-}"
IFS=',' read -r -a MODES    <<< "${HSM_BMT_MODES:-}"
IFS=',' read -r -a PAYLOADS <<< "${HSM_BMT_PAYLOADS:-}"
# Reject empty axes outright so an ad-hoc operator invocation without env
# vars fails fast instead of doing nothing for 6 minutes (which would also
# be a footgun).
if [ "${#ALGOS[@]}" -eq 0 ] || [ -z "${ALGOS[0]:-}" ]; then
  echo "[$(date -u +%T)] FATAL: HSM_BMT_ALGOS empty — refusing to run" >&2
  exit 2
fi
if [ "${#MODES[@]}" -eq 0 ] || [ -z "${MODES[0]:-}" ]; then
  echo "[$(date -u +%T)] FATAL: HSM_BMT_MODES empty — refusing to run" >&2
  exit 2
fi
if [ "${#PAYLOADS[@]}" -eq 0 ] || [ -z "${PAYLOADS[0]:-}" ]; then
  echo "[$(date -u +%T)] FATAL: HSM_BMT_PAYLOADS empty — refusing to run" >&2
  exit 2
fi
echo "[$(date -u +%T)] per-call wrapper matrix: algos=(${ALGOS[*]}) modes=(${MODES[*]}) payloads=(${PAYLOADS[*]})"

# Modes that use Sign instead of Encrypt — output for sample dump differs
# but DDB row stores them under "mode" identically.
mode_upper() { echo "$1" | tr a-z A-Z; }

run_cell() {
  local algo="$1" mode="$2" payload="$3"
  local algo_upper mode_upper procs
  algo_upper=$(mode_upper "$algo")
  mode_upper=$(mode_upper "$mode")
  if [ "$payload" = "256" ]; then procs="$HSM_BMT_PROCS_256"; else procs="$HSM_BMT_PROCS_1024"; fi

  # unit id matches the Java path's MeasurementUnit.unitId() format
  # (per_call_raw-{algo}-{mode}-{payload}B-c{size}-V{variant}); variant=NA
  # for PER_CALL family per MatrixGenerator.
  local unit_id="per_call_raw-${algo}-${mode}-${payload}B-c${SIZE}-VNA"
  echo "[$(date -u +%T)] cell $unit_id procs=$procs workers=$HSM_BMT_WORKER_COUNT"

  local tmpdir
  tmpdir=$(mktemp -d)
  for i in $(seq 0 $((procs - 1))); do
    # U-CH-5: telemetry labels — match Java path's process_idx semantics so
    # Grafana dual-series queries can sum across or split per-process.
    "$BENCH" \
      --threads "$HSM_BMT_WORKER_COUNT" \
      --seconds 360 \
      --algo "$algo" \
      --mode "$mode" \
      --payload "$payload" \
      --run-id "$RUN_ID" --unit-id "$unit_id" \
      --process-idx "$i" --cluster-size "$SIZE" \
      > "$tmpdir/p${i}.out" 2> "$tmpdir/p${i}.err" &
  done
  wait
  echo "[$(date -u +%T)] cell $unit_id all procs joined"

  # Aggregate per-proc outputs. tx_per_sec sums across procs; latency
  # percentiles take per-proc max for p95/p99 and per-proc avg for p50
  # (matches v3-bench-wrapper.sh aggregation semantics).
  local sum_ops=0 sum_p50=0 max_p95=0 max_p99=0 sum_errs=0 cnt=0
  local sample=""
  for i in $(seq 0 $((procs - 1))); do
    local out="$tmpdir/p${i}.out" err="$tmpdir/p${i}.err"
    local ops p50 p95 p99 errs
    ops=$(awk -F= '/^tx_per_sec=/ {print $2}' "$out")
    p50=$(awk '/^p50_ms=/ {gsub("p50_ms=","",$1); print $1}' "$out")
    p95=$(awk '/p95_ms=/ {for(i=1;i<=NF;i++) if($i ~ /^p95_ms=/) { gsub("p95_ms=","",$i); print $i }}' "$out")
    p99=$(awk '/p99_ms=/ {for(i=1;i<=NF;i++) if($i ~ /^p99_ms=/) { gsub("p99_ms=","",$i); print $i }}' "$out")
    errs=$(awk '/^threads=/ {for(i=1;i<=NF;i++) if($i ~ /^errs=/) { gsub("errs=","",$i); print $i }}' "$out")
    [ -z "$ops" ] && ops=0
    [ -z "$p50" ] && p50=0
    [ -z "$p95" ] && p95=0
    [ -z "$p99" ] && p99=0
    [ -z "$errs" ] && errs=0
    sum_ops=$(python3 -c "print($sum_ops + $ops)")
    sum_p50=$(python3 -c "print($sum_p50 + $p50)")
    sum_errs=$(python3 -c "print($sum_errs + $errs)")
    if (( $(python3 -c "print(1 if $p99 > $max_p99 else 0)") )); then max_p99=$p99; fi
    if (( $(python3 -c "print(1 if $p95 > $max_p95 else 0)") )); then max_p95=$p95; fi
    cnt=$((cnt + 1))
    if [ -z "$sample" ]; then
      sample=$(grep -oE 'PER_CALL sample.*: [0-9a-f]+' "$err" 2>/dev/null | head -1 | awk '{print $NF}')
    fi
  done
  local avg_p50
  avg_p50=$(python3 -c "print($sum_p50 / $cnt if $cnt else 0)")
  local p50_ns p95_ns p99_ns
  p50_ns=$(python3 -c "print(int($avg_p50 * 1e6))")
  p95_ns=$(python3 -c "print(int($max_p95 * 1e6))")
  p99_ns=$(python3 -c "print(int($max_p99 * 1e6))")

  echo "[$(date -u +%T)] cell $unit_id total ops/s=$sum_ops p50_avg=$avg_p50 p99_max=$max_p99 errs=$sum_errs"

  # bmt-units row. status=COMPLETED, family=PER_CALL_RAW, mode upper-cased.
  local now_iso
  now_iso=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  aws dynamodb put-item --region "$REGION" --table-name bmt-units --item "$(cat <<EOF
{
  "unitId":      {"S":"$unit_id"},
  "runId":       {"S":"$RUN_ID"},
  "status":      {"S":"COMPLETED"},
  "family":      {"S":"PER_CALL_RAW"},
  "algo":        {"S":"$algo_upper"},
  "mode":        {"S":"$mode_upper"},
  "payload":     {"N":"$payload"},
  "clusterSize": {"N":"$SIZE"},
  "variant":     {"S":"NA"},
  "opsPerSec":   {"N":"$sum_ops"},
  "p50Ns":       {"N":"$p50_ns"},
  "p95Ns":       {"N":"$p95_ns"},
  "p99Ns":       {"N":"$p99_ns"},
  "errorCount":  {"N":"$sum_errs"},
  "completedAt": {"S":"$now_iso"},
  "startedAt":   {"S":"$now_iso"},
  "loaderPath":  {"S":"c-native-multiproc"},
  "ctSample":    {"S":"$sample"}
}
EOF
)" >/dev/null

  # Parquet — write one per-proc file (proc={idx}/result.parquet). Aggregation
  # happens at report time (U-CH-7) so the per-proc rates and percentiles are
  # preserved for the operator report.
  for i in $(seq 0 $((procs - 1))); do
    local out="$tmpdir/p${i}.out"
    local p_ops p_p50 p_p95 p_p99
    p_ops=$(awk -F= '/^tx_per_sec=/ {print $2}' "$out"); [ -z "$p_ops" ] && p_ops=0
    p_p50=$(awk '/^p50_ms=/ {gsub("p50_ms=","",$1); print $1}' "$out"); [ -z "$p_p50" ] && p_p50=0
    p_p95=$(awk '/p95_ms=/ {for(j=1;j<=NF;j++) if($j ~ /^p95_ms=/) { gsub("p95_ms=","",$j); print $j }}' "$out"); [ -z "$p_p95" ] && p_p95=0
    p_p99=$(awk '/p99_ms=/ {for(j=1;j<=NF;j++) if($j ~ /^p99_ms=/) { gsub("p99_ms=","",$j); print $j }}' "$out"); [ -z "$p_p99" ] && p_p99=0
    local p_p50_ns p_p95_ns p_p99_ns
    p_p50_ns=$(python3 -c "print(int($p_p50 * 1e6))")
    p_p95_ns=$(python3 -c "print(int($p_p95 * 1e6))")
    p_p99_ns=$(python3 -c "print(int($p_p99 * 1e6))")
    /opt/hsm-bmt-report/venv/bin/python /opt/hsm-bmt/v3_to_parquet.py \
      --run-id "$RUN_ID" \
      --unit-id "$unit_id" \
      --family PER_CALL_RAW \
      --algo "$algo_upper" \
      --mode "$mode_upper" \
      --payload "$payload" \
      --cluster-size "$SIZE" \
      --variant NA \
      --process-idx "$i" \
      --ops-per-sec "$p_ops" \
      --p50-ns "$p_p50_ns" \
      --p95-ns "$p_p95_ns" \
      --p99-ns "$p_p99_ns" \
      --bucket "$S3_BUCKET" \
      --binary-sha256 "${EXPECTED_SHA256:-unknown}" \
      --binary-version-id "${EXPECTED_VERSION_ID:-unknown}" \
      || echo "[$(date -u +%T)] WARN: parquet write failed for $unit_id proc=$i"
  done

  # Increment bmt-runs.completedUnits (Java path doesn't, so this gives
  # the UI progress bar a real value for c-native runs).
  aws dynamodb update-item --region "$REGION" --table-name bmt-runs \
    --key "{\"runId\":{\"S\":\"$RUN_ID\"}}" \
    --update-expression "ADD completedUnits :inc" \
    --expression-attribute-values '{":inc":{"N":"1"}}' >/dev/null

  rm -rf "$tmpdir"
}

# Abort polling between cells (and during cool-down). orchestrator writes
# /hsm-bmt/runs/{runId}/abort=true via abort-run lambda; we exit non-zero
# so the orchestrator's child-handler also stops the cluster sweep.
abort_requested() {
  local val
  val=$(aws ssm get-parameter --region "$REGION" --name "/hsm-bmt/runs/${RUN_ID}/abort" \
        --query 'Parameter.Value' --output text 2>/dev/null) || return 1
  [ "$val" = "true" ]
}

# Iteration order: algo outermost, then mode, then payload — same as the
# Java MatrixGenerator default so unit_id sequencing matches.
for algo in "${ALGOS[@]}"; do
  for mode in "${MODES[@]}"; do
    for payload in "${PAYLOADS[@]}"; do
      if abort_requested; then
        echo "[$(date -u +%T)] abort requested — wrapper stopping before cell algo=$algo mode=$mode payload=$payload"
        exit 130
      fi
      run_cell "$algo" "$mode" "$payload"
      # Cell-to-cell cool-down: 30s baseline. Polled in 5s slices so abort
      # wakes within the same window. Operator can stretch via
      # HSM_BMT_CELL_COOLDOWN_S if a particular cluster needs more.
      target_cd="${HSM_BMT_CELL_COOLDOWN_S:-30}"
      slept=0
      while [ "$slept" -lt "$target_cd" ]; do
        if abort_requested; then
          echo "[$(date -u +%T)] abort requested during cool-down — wrapper exiting"
          exit 130
        fi
        sleep 5
        slept=$((slept + 5))
      done
    done
  done
done
echo "[$(date -u +%T)] per-call-bench-wrapper.sh done size=$SIZE"
