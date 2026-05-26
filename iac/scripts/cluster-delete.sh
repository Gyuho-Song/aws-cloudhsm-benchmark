#!/usr/bin/env bash
# Tear down the CloudHSM v2 cluster created by cluster-create.sh.
# Run BEFORE `cdk destroy CoreStack` (subnets can't be deleted while HSM ENIs exist).
#
# Reads /hsm-bmt/core/cluster-id from SSM and:
#   1. DeleteHsm for every HSM in the cluster (parallel kicks, sequential waits)
#   2. Wait for cluster to be empty
#   3. DeleteCluster
#   4. Remove the SSM parameter
set -euo pipefail
REGION=${AWS_REGION:-ap-northeast-2}

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

CLUSTER_ID=$(aws ssm get-parameter --region "$REGION" --name /hsm-bmt/core/cluster-id --query Parameter.Value --output text 2>/dev/null || true)
if [ -z "${CLUSTER_ID:-}" ] || [ "$CLUSTER_ID" = "None" ] || [[ "$CLUSTER_ID" == pending:* ]]; then
  log "No cluster ID in SSM, nothing to delete"
  exit 0
fi
log "Tearing down cluster $CLUSTER_ID"

# Step 1 — DeleteHsm for every HSM
HSM_IDS=$(aws cloudhsmv2 describe-clusters --region "$REGION" --filters "clusterIds=$CLUSTER_ID" \
  --query 'Clusters[0].Hsms[?State!=`DELETED`].HsmId' --output text || true)
if [ -n "${HSM_IDS:-}" ]; then
  for HSM_ID in $HSM_IDS; do
    log "  DeleteHsm $HSM_ID"
    aws cloudhsmv2 delete-hsm --region "$REGION" --cluster-id "$CLUSTER_ID" --hsm-id "$HSM_ID" >/dev/null || true
  done
fi

# Step 2 — wait for HSM count to reach 0
log "Waiting for HSMs to drain"
while true; do
  REMAINING=$(aws cloudhsmv2 describe-clusters --region "$REGION" --filters "clusterIds=$CLUSTER_ID" \
    --query 'length(Clusters[0].Hsms[?State!=`DELETED`])' --output text 2>/dev/null || echo 0)
  log "  HSMs remaining: $REMAINING"
  [ "$REMAINING" = "0" ] && break
  sleep 30
done

# Step 3 — DeleteCluster
log "DeleteCluster $CLUSTER_ID"
aws cloudhsmv2 delete-cluster --region "$REGION" --cluster-id "$CLUSTER_ID" >/dev/null || true

# Step 4 — clear SSM param so next deploy starts clean
aws ssm delete-parameter --region "$REGION" --name /hsm-bmt/core/cluster-id >/dev/null 2>&1 || true

log "DONE: $CLUSTER_ID deleted"
