import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { ddb } from './lib/ddb';
import { json, newRunId, validateMatrixSubset, StartRunInput } from './lib/types';
import { rangeError } from './lib/auth';
import { acquireRunLock, releaseRunLock, LockHeldByOther } from './lib/lock';
import { readClusterState, readActiveHsmCount } from './lib/cluster';

/**
 * 2026-05-25 HOS rewrite: single-region (apne2 only). The us-west-2
 * multi-cluster scale-out scenarios were retired along with V3 family.
 * SSM client / loader EC2 / S3 bucket are read from single env vars.
 */
const REGION = process.env.AWS_REGION ?? 'ap-northeast-2';
export const ssm = new SSMClient({ region: REGION });

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const tableName = process.env.RUNS_TABLE!;
  const loaderInstanceId = process.env.LOADER_INSTANCE_ID!;
  const resultsBucket = process.env.RESULTS_BUCKET!;

  if (!event.body) return json(400, { error: 'request body required' });

  let input: StartRunInput;
  try {
    input = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  if (!validateMatrixSubset(input.matrixSubset)) {
    return json(400, { error: 'matrixSubset is invalid (need families, algorithms, payloadBytes, clusterSizes)' });
  }
  if (!input.expectedLoaderVersionId || !input.expectedLoaderSha256) {
    return json(400, { error: 'expectedLoaderVersionId and expectedLoaderSha256 required (NFR-3.5)' });
  }
  // Optional worker-count override (PER_CALL_RAW saturation sweep). Validate range.
  if (input.workerCount !== undefined && input.workerCount !== null) {
    const n = Number(input.workerCount);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 16 || n > 1024) {
      return json(400, rangeError('workerCount', 16, 1024, input.workerCount));
    }
  }

  // 2026-05-25 HOS-Step7: cluster pre-flight gates run BEFORE any other
  // validation so a scaling-in-progress condition cannot leak into a
  // partial run state.
  const clusterState = await readClusterState();
  if (clusterState === 'scaling') {
    return json(409, {
      error: 'cluster_scaling_in_progress',
      message: 'HSM cluster scale operation in progress. Wait until ready.',
      hint: 'GET /api/cluster/status for current state',
    });
  }
  if (clusterState === 'unknown') {
    return json(503, {
      error: 'cluster_state_unknown',
      message: 'Cluster state could not be read (SSM transient failure?). Retry in a few seconds.',
    });
  }

  // Validate runner / procs (HOS: HARD-only, c-native-multiproc only).
  const runner = input.matrixSubset.runner ?? 'c-native-multiproc';
  if (!['java-multiproc', 'c-native-multiproc'].includes(runner)) {
    return json(400, { error: `unsupported runner: ${runner} (HOS only allows c-native-multiproc; java-multiproc retained for legacy)` });
  }
  const procs = input.matrixSubset.procs ?? 1;
  if (!Number.isInteger(procs) || procs < 1 || procs > 16) {
    return json(400, rangeError('procs', 1, 16, input.matrixSubset.procs));
  }
  const m = input.matrixSubset as { procs256?: number; procs1024?: number };
  if (m.procs256 != null) {
    const n = Number(m.procs256);
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      return json(400, rangeError('procs256', 1, 16, m.procs256));
    }
  }
  if (m.procs1024 != null) {
    const n = Number(m.procs1024);
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      return json(400, rangeError('procs1024', 1, 16, m.procs1024));
    }
  }
  const autoScale = !!input.matrixSubset.autoScale;
  if (!autoScale && input.matrixSubset.clusterSizes.length !== 1) {
    return json(400, {
      error: 'autoScale=false requires exactly one clusterSize (single-pass mode)',
    });
  }

  // Family gate: HOS-only PER_CALL_RAW. V3 / PER_CALL retired.
  const families = input.matrixSubset.families ?? [];
  if (families.includes('V3')) {
    return json(400, {
      error: 'V3 family is deprecated',
      hint: 'Use PER_CALL_RAW with c-native-multiproc',
    });
  }
  if (families.includes('PER_CALL')) {
    return json(400, {
      error: 'PER_CALL (legacy java) is deprecated',
      hint: 'Use PER_CALL_RAW with c-native-multiproc',
    });
  }
  if (!families.includes('PER_CALL_RAW') || families.length !== 1) {
    return json(400, { error: 'families must be exactly ["PER_CALL_RAW"]' });
  }
  // 2026-05-26: PER_CALL_RAW requires non-empty algorithms / modes / payloads /
  // clusterSizes. validateMatrixSubset only enforces algos/payloads/sizes; modes
  // was historically allowed empty (V3 didn't use modes). Without this guard an
  // empty matrix slipped through and the loader wrapper fell back to its
  // hardcoded defaults (aes_128/256 × 5 modes × 2 payloads = 20 cells full
  // sweep) — causing accidental full-matrix runs from a click on Custom with no
  // axes selected. Reject up front.
  if (!Array.isArray(input.matrixSubset.modes) || input.matrixSubset.modes.length === 0) {
    return json(400, {
      error: 'modes must contain at least one of ECB / CBC / CTR / GCM / CMAC',
      hint: 'Custom matrix axis 빈 상태에서 시작 시도 — 1개 이상 선택하세요',
    });
  }

  // HOS-Step7 ACTIVE-count gate: scenario asks for a minimum cluster size.
  // For HOS scenarios the front-end always sends matrixSubset.clusterSizes
  // populated; required = max(clusterSizes). Legacy callers without
  // requiredStartHsmCount fall back to the same formula.
  const required = Math.max(...input.matrixSubset.clusterSizes, 2);
  const activeCount = await readActiveHsmCount();
  if (activeCount < required) {
    return json(422, {
      error: 'cluster_not_ready',
      current: activeCount,
      required,
      hint: `POST /api/cluster/provision { targetCount: ${required} } first`,
    });
  }

  const runId = newRunId();
  const now = new Date().toISOString();
  // 2026-05-25 HOS-Step7: Operator (createdBy) extraction fix. The custom
  // authorizer (U-CH-1 Stage C) places identity at
  // event.requestContext.authorizer.context.{username,sub}, not the JWT
  // path that the previous code was reading. username is human-readable
  // (e.g. "bmt-admin"); sub is the Cognito UUID fallback.
  const ctx = (event.requestContext as { authorizer?: { context?: { username?: string; sub?: string } } })
    ?.authorizer?.context;
  const sub = ctx?.username ?? ctx?.sub ?? 'unknown';
  const totalUnits = countUnits(input.matrixSubset);
  const lockTable = process.env.RUNS_LOCK_TABLE!;

  // U-CH-2: Run-level concurrency lock — only one PENDING/RUNNING Run at a time.
  // ConditionalUpdate (attribute_not_exists OR ''). Throws LockHeldByOther on
  // conflict; we then 409 with active run details.
  try {
    await acquireRunLock(lockTable, runId, sub);
  } catch (err) {
    if (err instanceof LockHeldByOther) {
      let activeRunStatus: string | undefined;
      if (err.activeRunId) {
        try {
          const active = await ddb().send(new GetCommand({
            TableName: tableName,
            Key: { runId: err.activeRunId },
          }));
          activeRunStatus = active.Item?.status as string | undefined;
        } catch {
          // best-effort lookup — leave undefined
        }
      }
      return json(409, {
        error: 'another run is already in progress',
        activeRunId: err.activeRunId,
        activeRunStatus,
      });
    }
    throw err;
  }

  await ddb().send(new PutCommand({
    TableName: tableName,
    Item: {
      runId,
      status: 'PENDING',
      startedAt: now,
      totalUnits,
      completedUnits: 0,
      matrixSubset: input.matrixSubset,
      createdBy: sub,
      s3ResultsPrefix: `runs/${runId}/`,
      expectedLoaderVersionId: input.expectedLoaderVersionId,
      expectedLoaderSha256: input.expectedLoaderSha256,
      region: REGION,
    },
    ConditionExpression: 'attribute_not_exists(runId)',
  }));

  // Build runner.env. The orchestrator script
  // (/usr/local/bin/hsm-bmt-orchestrate.sh) reads these to dispatch to
  // the right loader path and to drive cluster auto-scale if requested.
  const sizes = input.matrixSubset.clusterSizes;
  const envLines = [
    `RUN_ID=${runId}`,
    `EXPECTED_VERSION_ID=${input.expectedLoaderVersionId}`,
    `EXPECTED_SHA256=${input.expectedLoaderSha256}`,
    `S3_BUCKET=${resultsBucket}`,
    `HSM_BMT_RUNNER=${runner}`,
    `HSM_BMT_PROCS=${procs}`,
    `HSM_BMT_AUTO_SCALE=${autoScale ? 1 : 0}`,
    `HSM_BMT_CLUSTER_SIZES=${sizes.join(',')}`,
  ];
  // Pass the matrix axis selection through to the c-native wrappers, which
  // were originally hardcoded to the full 2×5×2 matrix. Without these,
  // `per-call-bench-wrapper.sh` would always run all 20 cells regardless of
  // the user's matrixSubset (observed 2026-05-22 — smoke clicked 4 cells
  // but wrapper kept going past CTR/CMAC/GCM × AES_256). Java path ignores
  // these (it parses matrixSubset from DDB).
  const algos = (input.matrixSubset.algorithms ?? []).map((a) => a.toLowerCase()).join(',');
  const modes = (input.matrixSubset.modes ?? []).map((m) => m.toLowerCase()).join(',');
  const payloads = (input.matrixSubset.payloadBytes ?? []).join(',');
  // 2026-05-26: ALWAYS emit these env vars even if empty. The wrapper has
  // hardcoded fallback defaults (full 2×5×2 matrix) that fire when the
  // env var is unset. An empty env var, by contrast, evaluates to an empty
  // ALGOS array and the cell loop runs zero iterations — which is what we
  // want for a malformed input (the upstream validation now rejects empty
  // matrices, but this is belt-and-suspenders).
  envLines.push(`HSM_BMT_ALGOS=${algos}`);
  envLines.push(`HSM_BMT_MODES=${modes}`);
  envLines.push(`HSM_BMT_PAYLOADS=${payloads}`);
  // V3 has variants instead of modes; same channel as the others.
  const variants = (input.matrixSubset.variants ?? []).map((v) => v.toUpperCase()).join(',');
  if (variants) envLines.push(`HSM_BMT_VARIANTS=${variants}`);
  if (input.workerCount !== undefined && input.workerCount !== null) {
    envLines.push(`HSM_BMT_WORKER_COUNT=${Number(input.workerCount)}`);
  }
  // c-native wrapper dispatch needs the family so orchestrate.sh picks the
  // right wrapper script (v3-bench-wrapper vs per-call-bench-wrapper).
  // Java path ignores this — it reads families from DDB matrixSubset.
  if (runner === 'c-native-multiproc') {
    envLines.push(`HSM_BMT_FAMILY=${families[0] ?? 'V3'}`);
  }
  // procs256 / procs1024 are validated above; emit env if set.
  if (m.procs256 != null) envLines.push(`HSM_BMT_PROCS_256=${Number(m.procs256)}`);
  if (m.procs1024 != null) envLines.push(`HSM_BMT_PROCS_1024=${Number(m.procs1024)}`);
  // procsByCluster: HSM-adaptive procs (PER_CALL Full sweep). Encoded as
  // "size:procs,size:procs,..." e.g. "6:12,5:12,4:10,3:8,2:6". Orchestrator
  // looks up `${HSM_BMT_PROCS_BY_CLUSTER##*<size>:}` before each pass.
  // Source: 5/19 cluster-sat-results.csv sweet-spots.
  const pbc = (input.matrixSubset as { procsByCluster?: Record<string, number> }).procsByCluster;
  if (pbc && typeof pbc === 'object') {
    const enc = Object.entries(pbc)
      .map(([k, v]) => `${k}:${Number(v)}`)
      .join(',');
    if (enc) envLines.push(`HSM_BMT_PROCS_BY_CLUSTER=${enc}`);
  }
  // 2026-05-25 HOS: hardScale is mandatory in the live scenario set
  // (Smoke / PER_CALL Full HARD / PER_CALL Partial HARD / Custom HARD).
  // hardScale=true always — pass through to orchestrate.sh.
  const hardScale = !!(input.matrixSubset as { hardScale?: boolean }).hardScale;
  if (!hardScale) {
    return json(400, {
      error: 'hardScale=true is required (HOS retired soft scale)',
    });
  }
  envLines.push(`HSM_BMT_HARD_SCALE=1`);
  const envFile = envLines.join('\n');

  // Dispatch: write runner.env, launch orchestrate.sh in the background.
  // orchestrate.sh handles size sweep / hard-scale / wrapper invocation.
  const cmds = [
    `cat >/etc/hsm-bmt/runner.env <<'ENVEOF'\n${envFile}\nENVEOF`,
    `chown hsmbmt:hsmbmt /etc/hsm-bmt/runner.env`,
    `chmod 0640 /etc/hsm-bmt/runner.env`,
    // orchestrate.sh self-tees to /var/log/hsm-bmt/orchestrate.log via
    // `exec > >(tee -a $LOG) 2>&1`; do NOT also redirect here, that would
    // append every line twice (observed 2026-05-20 incident).
    `nohup /usr/local/bin/hsm-bmt-orchestrate.sh </dev/null >/dev/null 2>&1 &`,
    `disown`,
  ];

  try {
    await ssm.send(new SendCommandCommand({
      InstanceIds: [loaderInstanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: cmds },
      Comment: `Start ${runId} runner=${runner} procs=${procs}`.slice(0, 100),
    }));
  } catch (err) {
    // SSM SendCommand failed after lock was acquired and Run row written.
    // Release the lock and mark the Run row FAILED so the next start-run
    // can proceed. Cluster is untouched (no orchestrate.sh ran).
    try {
      await releaseRunLock(lockTable, runId);
    } catch { /* best-effort */ }
    try {
      await ddb().send(new UpdateCommand({
        TableName: tableName,
        Key: { runId },
        UpdateExpression: 'SET #s = :status, completedAt = :ts',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':status': 'FAILED',
          ':ts': new Date().toISOString(),
        },
      }));
    } catch { /* best-effort */ }
    return json(500, {
      error: 'internal_error',
      reason: 'SSM SendCommand 실패. 잠시 후 다시 시도하세요.',
    });
  }

  return json(202, { runId, status: 'PENDING' });
}

function countUnits(s: StartRunInput['matrixSubset']): number {
  // HOS: PER_CALL_RAW only (V3 / PER_CALL retired by the family gate above).
  // 2 algo × 5 mode × 2 payload × N clusterSizes = matrix size.
  return s.algorithms.length * Math.max(s.modes.length, 1) * s.payloadBytes.length * s.clusterSizes.length;
}
