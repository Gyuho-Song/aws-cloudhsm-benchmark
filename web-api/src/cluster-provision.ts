import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { ddb } from './lib/ddb';
import { json } from './lib/types';
import { readClusterState, readActiveHsmCount } from './lib/cluster';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-2';
const ssm = new SSMClient({ region: REGION });

interface ProvisionInput {
  targetCount: number;
}

/**
 * POST /api/cluster/provision  body: { targetCount: 2..6 }
 *
 * Operator-initiated cluster scale up/down. Refuses to run if:
 *   - cluster-state SSM lock is already 'scaling' (409)
 *   - bmt-runs-lock has an activeRunId (409 — measurement in progress)
 *   - targetCount equals current ACTIVE (200 noop)
 *
 * Otherwise dispatches `hard-scale-cluster.sh <targetCount>` to the loader
 * EC2 via SSM SendCommand. The script's own EXIT trap handles cluster-state
 * idle/scaling toggling. Returns 202 with estimated minutes.
 *
 * Scale-up takes ~25 min per HSM (CreateHsm + activation), scale-down
 * ~5 min per HSM (DeleteHsm propagation), plus 300s mesh stabilize at the
 * end. Estimate is rough — actual time can vary.
 *
 * Cognito group restriction (operator-only) is enforced by API Gateway
 * authorizer + custom-authorizer.ts; this handler trusts that filter.
 */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  if (!event.body) return json(400, { error: 'request body required' });

  let input: ProvisionInput;
  try {
    input = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  const target = Number(input.targetCount);
  if (!Number.isInteger(target) || target < 2 || target > 6) {
    return json(400, { error: 'targetCount must be integer 2..6', got: input.targetCount });
  }

  // Gate 1: scaling already in progress
  const state = await readClusterState();
  if (state === 'scaling') {
    return json(409, {
      error: 'already_scaling',
      message: 'Cluster scale operation already in progress.',
    });
  }
  if (state === 'unknown') {
    return json(503, { error: 'cluster_state_unknown' });
  }

  // Gate 2: a measurement run is in progress (provisioning during measurement
  // would yank HSMs out from under the running bench)
  const lockTable = process.env.RUNS_LOCK_TABLE!;
  try {
    const r = await ddb().send(new GetCommand({ TableName: lockTable, Key: { key: 'global' } }));
    const activeRunId = r.Item?.activeRunId as string | undefined;
    if (activeRunId && activeRunId !== '') {
      return json(409, {
        error: 'run_in_progress',
        activeRunId,
        message: 'Cannot provision while a run is active. Abort the run first.',
      });
    }
  } catch {
    // best-effort lookup — proceed cautiously
  }

  // Gate 3: noop if already at target
  const current = await readActiveHsmCount();
  if (current === target) {
    return json(200, { status: 'noop', current, target });
  }

  // Dispatch SSM SendCommand to loader EC2
  const loaderId = process.env.LOADER_INSTANCE_ID;
  if (!loaderId) return json(500, { error: 'LOADER_INSTANCE_ID not configured' });

  const cmd = new SendCommandCommand({
    InstanceIds: [loaderId],
    DocumentName: 'AWS-RunShellScript',
    Comment: `cluster-provision target=${target} from=${current}`.slice(0, 100),
    Parameters: {
      commands: [
        // detach so SendCommand returns quickly; hard-scale-cluster.sh logs to its own file
        `nohup /usr/local/bin/hard-scale-cluster.sh ${target} </dev/null >>/var/log/hsm-bmt/cluster-provision.log 2>&1 &`,
        'disown',
      ],
    },
  });

  let commandId: string | undefined;
  try {
    const r = await ssm.send(cmd);
    commandId = r.Command?.CommandId;
  } catch (err) {
    return json(500, { error: 'send_command_failed', detail: String(err) });
  }

  // Estimate: scale-up dominant (25 min/HSM), scale-down ~5 min/HSM
  const diff = Math.abs(target - current);
  const estimatedMinutes = target > current
    ? diff * 25 + 5  // up: ~25 min CreateHsm + 5 min stabilize
    : diff * 5 + 5;  // down: ~5 min DeleteHsm + 5 min stabilize

  return json(202, {
    status: 'started',
    current,
    target,
    estimatedMinutes,
    commandId,
  });
}
