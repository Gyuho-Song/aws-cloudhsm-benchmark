#!/usr/bin/env bash
# U-CH-6: customer-handover smoke verification.
#
# Runs after U-CH-1..U-CH-5, U-CH-7 are deployed. Walks through the canonical
# Smoke scenario (PC Partial cs=6, ECB+GCM, AES-128, 1024B, c-native-multiproc)
# end-to-end and asserts the eight handover ACs at each stage.
#
# IMPORTANT: this script makes real AWS calls. Run only on the loader EC2 or
# a host with the appropriate IAM role, after deploying the new web-stack
# (CDK) and updated loader binary.
#
# Inputs (env):
#   SMOKE_RUN_LABEL — label for the smoke run (default: SmokeUCH6)
#   API_URL         — API Gateway URL (defaults to SSM /hsm-bmt/web/api-endpoint)
#   ADMIN_TOKEN     — Cognito ID token for admin user (operator must export)
#   VIEWER_TOKEN    — Cognito ID token for viewer user (operator must export)
#
# Exits non-zero on any AC failure. Logs each step to stderr.

set -euo pipefail
LABEL="${SMOKE_RUN_LABEL:-SmokeUCH6}"
REGION=ap-northeast-2

log() { echo "[$(date -u +%T)] $*" >&2; }
fail() { echo "FAIL: $*" >&2; exit 1; }

if [ -z "${ADMIN_TOKEN:-}" ]; then fail "ADMIN_TOKEN env required"; fi
if [ -z "${VIEWER_TOKEN:-}" ]; then fail "VIEWER_TOKEN env required"; fi

# G4: AC-12 leg uses a temporary SQS queue subscribed to the alert SNS topic
# to verify alarm → SNS delivery. Set SKIP_AC12=1 to skip the alarm-firing
# leg (e.g. when running outside a maintenance window — pushing fake metric
# data flaps the live alarms).
SKIP_AC12="${SKIP_AC12:-0}"
SMOKE_QUEUE_URL=""
SMOKE_SUBSCRIPTION_ARN=""

cleanup_ac12() {
  # Best-effort teardown — never fail the script on cleanup errors.
  if [ -n "$SMOKE_SUBSCRIPTION_ARN" ]; then
    aws sns unsubscribe --region "$REGION" \
      --subscription-arn "$SMOKE_SUBSCRIPTION_ARN" >/dev/null 2>&1 || true
  fi
  if [ -n "$SMOKE_QUEUE_URL" ]; then
    aws sqs delete-queue --region "$REGION" \
      --queue-url "$SMOKE_QUEUE_URL" >/dev/null 2>&1 || true
  fi
}
trap cleanup_ac12 EXIT

API_URL="${API_URL:-$(aws ssm get-parameter --region "$REGION" \
  --name /hsm-bmt/web/api-endpoint --query Parameter.Value --output text)}"
API_URL="${API_URL%/}"   # strip trailing slash
log "API_URL=$API_URL label=$LABEL"

# ---- AC-3 : viewer cannot start a run (403) -------------------------------
log "AC-3 viewer 403 check"
http_code=$(curl -s -o /tmp/viewer-403.json -w "%{http_code}" \
  -X POST "$API_URL/runs" \
  -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"matrixSubset":{"families":["PER_CALL_RAW"],"algorithms":["AES_128"],"modes":["ECB"],"payloadBytes":[1024],"clusterSizes":[6],"variants":[],"runner":"c-native-multiproc","procs":4},"expectedLoaderVersionId":"x","expectedLoaderSha256":"y"}')
[ "$http_code" = "403" ] || fail "viewer should get 403, got $http_code"
grep -q '"forbidden"\|"reason"' /tmp/viewer-403.json || fail "expected forbidden body"
log "  ok: viewer 403 with korean reason"

# ---- AC-5 : start a smoke Run (admin) ------------------------------------
log "AC-5 admin start smoke run"
LOADER_VID=$(aws ssm get-parameter --region "$REGION" \
  --name /hsm-bmt/loader/version-id --query Parameter.Value --output text)
LOADER_SHA=$(aws ssm get-parameter --region "$REGION" \
  --name /hsm-bmt/loader/sha256 --query Parameter.Value --output text)
http_code=$(curl -s -o /tmp/start.json -w "%{http_code}" \
  -X POST "$API_URL/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "matrixSubset": {
    "families": ["PER_CALL_RAW"],
    "algorithms": ["AES_128"],
    "modes": ["ECB", "GCM"],
    "payloadBytes": [1024],
    "clusterSizes": [6],
    "variants": [],
    "runner": "c-native-multiproc",
    "procs": 4
  },
  "expectedLoaderVersionId": "$LOADER_VID",
  "expectedLoaderSha256":    "$LOADER_SHA"
}
EOF
)")
[ "$http_code" = "202" ] || fail "smoke start expected 202, got $http_code; body=$(cat /tmp/start.json)"
RUN_ID=$(python3 -c "import json,sys; print(json.load(open('/tmp/start.json'))['runId'])")
log "  ok: started run $RUN_ID"

# ---- 2nd admin start during RUNNING → 409 with activeRunId ----------------
log "AC-5b second start should 409"
http_code=$(curl -s -o /tmp/conflict.json -w "%{http_code}" \
  -X POST "$API_URL/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat /tmp/start.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"matrixSubset":{"families":["PER_CALL_RAW"],"algorithms":["AES_128"],"modes":["ECB"],"payloadBytes":[1024],"clusterSizes":[6],"variants":[],"runner":"c-native-multiproc","procs":4},"expectedLoaderVersionId":"a","expectedLoaderSha256":"b"}))')")
[ "$http_code" = "409" ] || fail "expected 409, got $http_code"
ACTIVE=$(python3 -c "import json; print(json.load(open('/tmp/conflict.json'))['activeRunId'])")
[ "$ACTIVE" = "$RUN_ID" ] || fail "activeRunId mismatch: expected $RUN_ID, got $ACTIVE"
log "  ok: 409 with activeRunId=$ACTIVE"

# ---- AC-6 : range hint (procs out of range) ------------------------------
log "AC-6 range hint check"
http_code=$(curl -s -o /tmp/range.json -w "%{http_code}" \
  -X POST "$API_URL/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"matrixSubset":{"families":["PER_CALL_RAW"],"algorithms":["AES_128"],"modes":["ECB"],"payloadBytes":[1024],"clusterSizes":[6],"variants":[],"runner":"c-native-multiproc","procs":99},"expectedLoaderVersionId":"a","expectedLoaderSha256":"b"}')
[ "$http_code" = "400" ] || fail "expected 400, got $http_code"
grep -q '한국어\|정수\|procs.*1.*16\|procs' /tmp/range.json || fail "expected procs hint"
log "  ok: 400 procs hint"

# ---- Wait for completion (or 30 min hard cap) ----------------------------
log "Waiting for $RUN_ID to complete (~25 min)"
deadline=$(($(date +%s) + 30 * 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  status=$(curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$API_URL/runs/$RUN_ID/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null || echo "?")
  log "  status=$status"
  case "$status" in
    COMPLETED) break ;;
    FAILED|ABORTED) fail "run ended in status=$status" ;;
  esac
  sleep 30
done
[ "$status" = "COMPLETED" ] || fail "smoke did not complete in 30 min"

# ---- AC-7 : report exists in S3 ------------------------------------------
log "AC-7 report artefacts"
RESULTS_BUCKET=$(aws ssm get-parameter --region "$REGION" \
  --name /hsm-bmt/core/s3-bucket-name --query Parameter.Value --output text)
aws s3 ls "s3://$RESULTS_BUCKET/runs/$RUN_ID/report.html" >/dev/null \
  || fail "report.html missing"
aws s3 ls "s3://$RESULTS_BUCKET/runs/$RUN_ID/report.pdf" >/dev/null \
  || fail "report.pdf missing"
log "  ok: html + pdf present"

# ---- AC-FR-CH-8-C : per-proc parquet present (multi-proc reduce input) ---
log "AC-FR-CH-8-C per-proc parquet"
N_PARQUET=$(aws s3 ls --recursive "s3://$RESULTS_BUCKET/runs/$RUN_ID/family=PER_CALL_RAW/" \
  | grep -c '/proc=.*/result.parquet$' || true)
[ "$N_PARQUET" -ge 4 ] || fail "expected ≥ 4 per-proc parquet, got $N_PARQUET"
log "  ok: $N_PARQUET per-proc parquet under proc=*"

# ---- viewer can fetch report (AC-4) -------------------------------------
log "AC-4 viewer GET run / report ok"
http_code=$(curl -s -o /tmp/viewer-run.json -w "%{http_code}" \
  -H "Authorization: Bearer $VIEWER_TOKEN" "$API_URL/runs/$RUN_ID")
[ "$http_code" = "200" ] || fail "viewer GET should 200, got $http_code"
http_code=$(curl -s -o /tmp/viewer-report.json -w "%{http_code}" \
  -L -H "Authorization: Bearer $VIEWER_TOKEN" "$API_URL/reports/$RUN_ID")
[ "$http_code" = "200" ] || fail "viewer GET report should 200, got $http_code"
log "  ok: viewer can read run + report"

# ---- AC-12 : alarm fires + SNS delivers --------------------------------
# We do NOT induce real Lambda errors (that would interfere with concurrent
# customer auth). Instead push synthetic AWS/Lambda Errors datapoints via
# CloudWatch PutMetricData against the real Lambda function names — same
# metric the alarm watches, so it fires deterministically.
if [ "$SKIP_AC12" = "1" ]; then
  log "SKIP_AC12=1 — skipping alarm-firing leg"
else
  log "AC-12 alarm + SNS delivery"

  ALERT_TOPIC_ARN=$(aws ssm get-parameter --region "$REGION" \
    --name /hsm-bmt/observability/alert-sns-topic-arn \
    --query Parameter.Value --output text)
  PRETOKEN_FN=$(aws ssm get-parameter --region "$REGION" \
    --name /hsm-bmt/web/pretokengen-fn-name \
    --query Parameter.Value --output text)
  AUTHORIZER_FN=$(aws ssm get-parameter --region "$REGION" \
    --name /hsm-bmt/web/authorizer-fn-name \
    --query Parameter.Value --output text)

  # 1. create temporary SQS queue + subscribe to alert topic
  QUEUE_NAME="hsm-bmt-smoke-alerts-$$-$(date +%s)"
  SMOKE_QUEUE_URL=$(aws sqs create-queue --region "$REGION" \
    --queue-name "$QUEUE_NAME" \
    --attributes 'MessageRetentionPeriod=600' \
    --query QueueUrl --output text)
  QUEUE_ARN=$(aws sqs get-queue-attributes --region "$REGION" \
    --queue-url "$SMOKE_QUEUE_URL" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

  # SNS-to-SQS requires the queue to allow SendMessage from the topic.
  aws sqs set-queue-attributes --region "$REGION" \
    --queue-url "$SMOKE_QUEUE_URL" \
    --attributes "$(cat <<EOF
{"Policy":"{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$QUEUE_ARN\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"$ALERT_TOPIC_ARN\"}}}]}"}
EOF
)" >/dev/null
  SMOKE_SUBSCRIPTION_ARN=$(aws sns subscribe --region "$REGION" \
    --topic-arn "$ALERT_TOPIC_ARN" --protocol sqs \
    --notification-endpoint "$QUEUE_ARN" \
    --query SubscriptionArn --output text)
  log "  ok: SQS $QUEUE_NAME subscribed"

  # 2. push synthetic Errors datapoints — A1 needs ≥1, A3 needs ≥5.
  for v in 1 1; do
    aws cloudwatch put-metric-data --region "$REGION" \
      --namespace AWS/Lambda --metric-name Errors \
      --dimensions FunctionName="$PRETOKEN_FN" --value "$v" --unit Count
  done
  for v in 1 1 1 1 1 1; do
    aws cloudwatch put-metric-data --region "$REGION" \
      --namespace AWS/Lambda --metric-name Errors \
      --dimensions FunctionName="$AUTHORIZER_FN" --value "$v" --unit Count
  done
  log "  pushed synthetic Errors metrics (A1×2, A3×6)"

  # 3. wait for alarm evaluation (5min period + 1min slack).
  log "  waiting 6 min for alarm evaluation..."
  sleep 360

  # 4. assert both alarms in ALARM state
  for alarm in hsm-bmt-pretokengen-errors-p1 hsm-bmt-authorizer-errors; do
    state=$(aws cloudwatch describe-alarms --region "$REGION" \
      --alarm-names "$alarm" \
      --query 'MetricAlarms[0].StateValue' --output text)
    [ "$state" = "ALARM" ] || fail "alarm $alarm did not fire (state=$state)"
  done
  log "  ok: A1 + A3 both ALARM"

  # 5. drain SQS — must have ≥2 messages (one per alarm)
  N_MSGS=0
  for _ in 1 2 3 4; do
    BATCH=$(aws sqs receive-message --region "$REGION" \
      --queue-url "$SMOKE_QUEUE_URL" \
      --max-number-of-messages 10 --wait-time-seconds 5 \
      --query 'Messages[].MessageId' --output text 2>/dev/null || true)
    if [ -n "$BATCH" ] && [ "$BATCH" != "None" ]; then
      N_MSGS=$((N_MSGS + $(echo "$BATCH" | wc -w)))
    fi
  done
  [ "$N_MSGS" -ge 2 ] || fail "expected ≥2 SNS deliveries, got $N_MSGS"
  log "  ok: $N_MSGS SNS deliveries received"
fi

log "ALL SMOKE CHECKS PASSED — run $RUN_ID"
