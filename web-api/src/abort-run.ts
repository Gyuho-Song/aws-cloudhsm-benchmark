import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SSMClient, PutParameterCommand, SendCommandCommand } from '@aws-sdk/client-ssm';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { ddb } from './lib/ddb';
import { json } from './lib/types';
import { releaseRunLock } from './lib/lock';

// 2026-05-24 multi-cluster scale-out: per-region SSM clients, same pattern as
// start-run.ts. abort-run reads run.region from DDB to choose the target.
const ssmClients: Map<string, SSMClient> = new Map();
function ssmFor(region: string): SSMClient {
  let c = ssmClients.get(region);
  if (!c) { c = new SSMClient({ region }); ssmClients.set(region, c); }
  return c;
}

interface RegionMap { [region: string]: string }
function parseRegionMap(csv: string | undefined, fallbackRegion: string, fallbackValue: string): RegionMap {
  const out: RegionMap = { [fallbackRegion]: fallbackValue };
  if (!csv) return out;
  for (const entry of csv.split(',')) {
    const [r, v] = entry.split(':').map((s) => s.trim());
    if (r && v) out[r] = v;
  }
  return out;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const runId = event.pathParameters?.id;
  if (!runId) return json(400, { error: 'runId path parameter required' });

  const tableName = process.env.RUNS_TABLE!;
  const abortPrefix = process.env.ABORT_SSM_PREFIX!;
  const lockTable = process.env.RUNS_LOCK_TABLE!;
  const homeRegion = process.env.AWS_REGION ?? 'ap-northeast-2';
  const loaderByRegion = parseRegionMap(
    process.env.LOADER_INSTANCE_ID_BY_REGION,
    homeRegion,
    process.env.LOADER_INSTANCE_ID!,
  );

  // Look up the run to get its region (default 'ap-northeast-2' for legacy
  // rows without the region field). Failure to find the row is not fatal —
  // we still want the abort to proceed against the home region (default).
  let region = homeRegion;
  try {
    const got = await ddb().send(new GetCommand({ TableName: tableName, Key: { runId } }));
    region = (got.Item?.region as string | undefined) ?? homeRegion;
  } catch {
    // best-effort
  }
  const loaderInstanceId = loaderByRegion[region] ?? loaderByRegion[homeRegion];
  const ssm = ssmFor(region);

  // Two-channel abort:
  //   1. SSM Parameter — orchestrate.sh / wrappers poll this between cells
  //      (cooperative stop; takes effect at next poll interval, ≤ 5 s).
  //   2. SSM SendCommand SIGTERM — orchestrate.sh's SIGTERM trap calls
  //      abort_now() immediately, killing in-flight bench children. This
  //      is the "instant stop" path; the Param is the persistent record.
  //
  // Without channel 2 the wrapper had to finish its current cell (~6 min)
  // before noticing abort — observed 2026-05-23 incident where a UI abort
  // at 10% progress let the wrapper continue to 50% before stopping.
  await ssm.send(new PutParameterCommand({
    Name: `${abortPrefix}${runId}/abort`,
    Value: 'true',
    Type: 'String',
    Overwrite: true,
  }));

  // SIGTERM the orchestrator (and any descendants — bench wrappers and
  // bench binaries — via the orchestrator's SIGTERM trap which calls
  // pkill on its child tree). Best-effort: if the loader instance is
  // unreachable we still rely on the cooperative Param poll.
  try {
    await ssm.send(new SendCommandCommand({
      InstanceIds: [loaderInstanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: {
        commands: [
          // 2026-05-26 (Phase D): kill children FIRST, then orchestrator.
          // Children's EXIT traps need orchestrate.sh still alive to log;
          // more importantly, hard-scale-cluster.sh's EXIT trap restores
          // cluster-state=idle — if we kill orchestrate first, that trap
          // still runs but the user-facing cluster-state lock takes longer
          // to clear because hard-scale-cluster.sh might still be sleeping
          // 300s. Order: bench → wrappers → hard-scale → orchestrate.
          // matches /tmp/per_call_bench (legacy) and /usr/local/bin/per_call_bench (current)
          'pkill -TERM -f "per_call_bench" 2>/dev/null || true',
          'pkill -TERM -f "v3_bench" 2>/dev/null || true',
          'pkill -TERM -f "per-call-bench-wrapper.sh" 2>/dev/null || true',
          'pkill -TERM -f "v3-bench-wrapper.sh" 2>/dev/null || true',
          'pkill -TERM -f "hard-scale-cluster.sh" 2>/dev/null || true',
          // brief pause for EXIT traps (cluster-state=idle SSM put)
          'sleep 1',
          'pkill -TERM -f "hsm-bmt-orchestrate.sh" 2>/dev/null || true',
        ],
      },
      Comment: `abort ${runId}`.slice(0, 100),
    }));
  } catch {
    // Don't block the abort response on SendCommand failure — the
    // cooperative SSM-Param poll path will still trigger.
  }

  await ddb().send(new UpdateCommand({
    TableName: tableName,
    Key: { runId },
    UpdateExpression: 'SET #s = :status, completedAt = :ts',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':status': 'ABORTED',
      ':ts': new Date().toISOString(),
    },
    ConditionExpression: 'attribute_exists(runId)',
  }));

  // U-CH-2: release Run-level lock if this runId held it (silent no-op if held by other).
  await releaseRunLock(lockTable, runId);

  return json(200, { runId, status: 'ABORTED' });
}
