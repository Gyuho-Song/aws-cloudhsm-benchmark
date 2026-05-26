import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SSMClient, PutParameterCommand, DeleteParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

import { json } from './lib/types';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-2';
const ssm = new SSMClient({ region: REGION });

/**
 * POST /api/cluster/force-unlock
 *
 * Admin-only emergency tool (Phase F of cluster-state-rca-plan).
 *
 * When hard-scale-cluster.sh's EXIT trap fails to fire — e.g. process
 * killed with SIGKILL, EC2 power-loss mid-script, AWS API throttling on
 * the put-parameter call — the SSM /hsm-bmt/core/cluster-state can be
 * left at 'scaling' indefinitely. The cluster-status lambda flips uiState
 * to 'stale' after 90 minutes; this endpoint clears the lock.
 *
 * IMPORTANT: this is a recovery tool, not a normal operation. The UI
 * gates the button behind:
 *   - admin Cognito group (custom-authorizer ENDPOINT_MATRIX = 'admin')
 *   - uiState='stale' visibility
 *   - window.confirm prompt
 *
 * Force-unlock during a legitimate scale operation will let a new run
 * start mid-scale and break invariants. Operators must verify (e.g. via
 * SSM SendCommand `pgrep hard-scale-cluster.sh`) that no scale is in
 * flight before clicking.
 */
export async function handler(_event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  // Read previous state for the audit log entry.
  let previousState = 'unknown';
  try {
    const r = await ssm.send(new GetParameterCommand({
      Name: '/hsm-bmt/core/cluster-state',
    }));
    previousState = r.Parameter?.Value ?? 'unknown';
  } catch {
    // Parameter may not exist on first-ever unlock — treat as unknown.
  }

  // Hard-set to idle.
  await ssm.send(new PutParameterCommand({
    Name: '/hsm-bmt/core/cluster-state',
    Value: 'idle',
    Type: 'String',
    Overwrite: true,
  }));

  // Best-effort delete of the since timestamp so the next legitimate
  // scaling event starts fresh. Tolerate ParameterNotFound.
  try {
    await ssm.send(new DeleteParameterCommand({
      Name: '/hsm-bmt/core/cluster-state-since',
    }));
  } catch {
    // ignore
  }

  return json(200, {
    status: 'unlocked',
    previousState,
    clearedAt: new Date().toISOString(),
  });
}
