#!/usr/bin/env bash
# Apply alert-manager.yaml to the AMP workspace via API. Run AFTER
# `cdk deploy ObservabilityStack` in regions where AWS::APS::AlertManagerDefinition
# is not yet a valid CFN type (e.g., ap-northeast-2 as of 2026-05).
#
# Reads:
#   - /hsm-bmt/observability/amp-workspace-id (SSM)
#   - /hsm-bmt/observability/alert-sns-topic-arn (SSM, used for ${SNS_TOPIC_ARN} substitution)
# Applies:
#   - iac/assets/alert-manager.yaml -> AMP workspace
set -euo pipefail
REGION=${AWS_REGION:-ap-northeast-2}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TEMPLATE="$SCRIPT_DIR/../assets/alert-manager.yaml"

WORKSPACE_ID=$(aws ssm get-parameter --region "$REGION" --name /hsm-bmt/observability/amp-workspace-id --query Parameter.Value --output text)
SNS_TOPIC_ARN=$(aws ssm get-parameter --region "$REGION" --name /hsm-bmt/observability/alert-sns-topic-arn --query Parameter.Value --output text)
echo "[$(date '+%H:%M:%S')] AMP workspace: $WORKSPACE_ID"
echo "[$(date '+%H:%M:%S')] SNS topic: $SNS_TOPIC_ARN"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
sed "s|\${SNS_TOPIC_ARN}|$SNS_TOPIC_ARN|g" "$TEMPLATE" > "$WORK/alert-manager.yaml"

aws amp create-alert-manager-definition --region "$REGION" \
  --workspace-id "$WORKSPACE_ID" \
  --data "fileb://$WORK/alert-manager.yaml" 2>/dev/null \
  || aws amp put-alert-manager-definition --region "$REGION" \
       --workspace-id "$WORKSPACE_ID" \
       --data "fileb://$WORK/alert-manager.yaml"

echo "[$(date '+%H:%M:%S')] Alert manager definition applied"
