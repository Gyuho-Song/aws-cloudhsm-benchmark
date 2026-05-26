#!/usr/bin/env bash
# Sync the hsm_bmt_report Python package from this repo to the loader EC2's
# /opt/hsm-bmt-report installation. Use after any commit that touches
# report/src/ or report/templates/. Run from the repo root or anywhere —
# script auto-locates its sources.
#
# Why this exists: render-report.sh runs the Python module out of /opt and
# nothing else automatically pulls newer source. Stale src has caused
# silent report failures in the past (2026-05-22 — Family.PER_CALL_RAW
# missing made every COMPLETED run produce zero artifacts).

set -euo pipefail

REGION=${REGION:-ap-northeast-2}
BUCKET=${BUCKET:-hsm-bmt-results-<AWS_ACCOUNT_ID>-ap-northeast-2}
LOADER_EC2=${LOADER_EC2:-<LOADER_EC2_ID>}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_SRC="$REPO_ROOT/report"

if [ ! -d "$REPORT_SRC/src/hsm_bmt_report" ]; then
  echo "FATAL: report/ not found at $REPORT_SRC" >&2
  exit 1
fi

echo "[1/3] uploading report/ to s3://$BUCKET/report-src/"
aws s3 sync "$REPORT_SRC/" "s3://$BUCKET/report-src/" \
  --delete --region "$REGION" \
  --exclude "tests/*" --exclude "*.pyc" --exclude "__pycache__/*" \
  --exclude ".pytest_cache/*" --exclude ".ruff_cache/*"

echo "[2/3] running sync on $LOADER_EC2 via SSM"
CMD_ID=$(aws ssm send-command \
  --document-name AWS-RunShellScript \
  --instance-ids "$LOADER_EC2" \
  --region "$REGION" \
  --comment "sync-report-package.sh: pull report-src and verify Family enum" \
  --parameters '{"commands":[
    "set -ex",
    "find /opt/hsm-bmt-report/src -name __pycache__ -prune -exec rm -rf {} + || true",
    "sudo -u ec2-user aws s3 sync s3://'"$BUCKET"'/report-src/src/ /opt/hsm-bmt-report/src/ --delete --region '"$REGION"' --exclude \"*.egg-info/*\"",
    "sudo -u ec2-user aws s3 sync s3://'"$BUCKET"'/report-src/templates/ /opt/hsm-bmt-report/templates/ --delete --region '"$REGION"'",
    "sudo -u ec2-user aws s3 sync s3://'"$BUCKET"'/report-src/static/ /opt/hsm-bmt-report/static/ --delete --region '"$REGION"'",
    "sudo -u ec2-user /opt/hsm-bmt-report/venv/bin/python -c \"from hsm_bmt_report.models import Family; vals=[f.value for f in Family]; assert \\\"PER_CALL_RAW\\\" in vals, vals; print(\\\"OK\\\", vals)\""
  ]}' \
  --output text --query 'Command.CommandId')

echo "  SSM CommandId=$CMD_ID — waiting…"
for _ in $(seq 1 20); do
  STAT=$(aws ssm get-command-invocation \
    --command-id "$CMD_ID" --instance-id "$LOADER_EC2" \
    --region "$REGION" --query 'Status' --output text 2>&1)
  case "$STAT" in
    Success|Failed|Cancelled) break ;;
  esac
  sleep 5
done

OUT=$(aws ssm get-command-invocation \
  --command-id "$CMD_ID" --instance-id "$LOADER_EC2" \
  --region "$REGION" --query 'StandardOutputContent' --output text)
ERR=$(aws ssm get-command-invocation \
  --command-id "$CMD_ID" --instance-id "$LOADER_EC2" \
  --region "$REGION" --query 'StandardErrorContent' --output text)

echo "[3/3] verifying Family enum on loader"
echo "  STDOUT:"
echo "$OUT" | sed 's/^/    /'
if [ "$STAT" != "Success" ]; then
  echo "  STDERR:"
  echo "$ERR" | sed 's/^/    /'
  echo "FATAL: SSM execution status=$STAT" >&2
  exit 2
fi

if echo "$OUT" | grep -q "OK \['V3', 'PER_CALL', 'PER_CALL_RAW'\]"; then
  echo "✓ report package sync successful — Family enum has PER_CALL_RAW"
else
  echo "✗ Family enum check failed — see STDOUT above" >&2
  exit 3
fi
