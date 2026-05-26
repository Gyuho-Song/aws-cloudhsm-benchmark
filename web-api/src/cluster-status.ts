import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

import { json } from './lib/types';
import { readClusterStatus } from './lib/cluster';

/**
 * GET /api/cluster/status
 *
 * Returns a cluster-wide snapshot for the UI badge:
 *   { activeCount, totalHsms, desiredCount, states[], clusterState,
 *     hardScaleStatus, uiState, updatedAt }
 *
 * Rendered by HsmStatusBadge.tsx — polled at 30s (idle) or 10s (scaling).
 * No auth check beyond API Gateway authorizer (any authenticated user).
 */
export async function handler(_event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const status = await readClusterStatus();
  return json(200, status);
}
