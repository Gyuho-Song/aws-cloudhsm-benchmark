#!/usr/bin/env bash
# Render Korean BMT report (HTML + PDF) for the given run, then upload to
# s3://$S3_BUCKET/reports/$RUN_ID/. Triggered by the report-trigger Lambda
# via SSM SendCommand whenever a run flips to status=COMPLETED.
#
# Inputs (env):
#   RUN_ID    -- e.g. rid-20260517084500
#   S3_BUCKET -- results bucket name (already written by CoreStack)
#
# The report Python package and its deps are installed once by the
# install-report-deps.sh helper; this script just runs the CLI.
set -euo pipefail
LOG=/var/log/hsm-bmt/render-report.log
mkdir -p /var/log/hsm-bmt
exec > >(tee -a "$LOG") 2>&1

: "${RUN_ID:?RUN_ID env required}"
: "${S3_BUCKET:?S3_BUCKET env required}"

echo "[$(date '+%H:%M:%S')] rendering report for $RUN_ID -> s3://$S3_BUCKET/reports/$RUN_ID/"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

/opt/hsm-bmt-report/venv/bin/python -m hsm_bmt_report \
  --run-id "$RUN_ID" \
  --bucket "$S3_BUCKET" \
  --output-dir "$WORK"

ls -la "$WORK"

aws s3 cp "$WORK/report.html" "s3://$S3_BUCKET/reports/$RUN_ID/index.html" \
  --content-type 'text/html; charset=utf-8'
if [ -f "$WORK/report.pdf" ]; then
  aws s3 cp "$WORK/report.pdf" "s3://$S3_BUCKET/reports/$RUN_ID/report.pdf" \
    --content-type 'application/pdf'
fi

echo "[$(date '+%H:%M:%S')] DONE"
