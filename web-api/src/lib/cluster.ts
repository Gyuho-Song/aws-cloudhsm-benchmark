/**
 * Cluster state helpers — used by cluster-status, cluster-provision and
 * start-run lambdas. Reads SSM Parameter Store + cloudhsmv2:DescribeClusters
 * to compute the four UI states {idle, degraded, scaling, unknown}.
 */
import { SSMClient, GetParameterCommand, GetParametersCommand } from '@aws-sdk/client-ssm';
import { CloudHSMV2Client, DescribeClustersCommand } from '@aws-sdk/client-cloudhsm-v2';

// 2026-05-26 (Phase E): 'stale' = scaling lock has been held for > STALE_TTL_MIN
// minutes. UI shows a force-unlock button to admins.
export type UiState = 'idle' | 'degraded' | 'scaling' | 'stale' | 'unknown';

/** Stale threshold. cs=2 → cs=6 hard scale-up worst case is ~105 min
 *  (4 × CreateHsm × 25 min + stabilize). 90 min triggers stale display
 *  but still allows a long legitimate scale-up to finish without the
 *  operator panicking — they can ignore the stale chip if they know the
 *  scale is legitimate. */
const STALE_TTL_MIN = 90;

export interface ClusterStatus {
  /** ACTIVE HSM count seen by AWS control plane right now. */
  activeCount: number;
  /** Total HSMs in cluster (any state including CREATE_IN_PROGRESS). */
  totalHsms: number;
  /** Configured target cluster size, from SSM `/hsm-bmt/core/desired-hsm-count`. */
  desiredCount: number;
  /** Per-HSM states (e.g. ['ACTIVE','ACTIVE','CREATE_IN_PROGRESS', ...]). */
  states: string[];
  /** SSM lock value: 'idle' | 'scaling'. 'unknown' on read failure. */
  clusterState: 'idle' | 'scaling' | 'unknown';
  /** Last scale operation outcome: 'ok' | 'degraded'. 'unknown' on read failure. */
  hardScaleStatus: 'ok' | 'degraded' | 'unknown';
  /** Server-side computed UI state: see UiState. */
  uiState: UiState;
  /** Phase E: when uiState='stale', how old the scaling lock is. */
  staleSince?: string;
  staleAgeMinutes?: number;
  /** 2026-05-26: the target HSM count of the in-flight scale operation,
   *  populated when uiState is 'scaling' or 'stale'. UI displays
   *  `current → scalingTarget` instead of `current → desiredCount`. */
  scalingTarget?: number;
  /** 2026-05-26: when uiState='scaling', the ISO timestamp at which the
   *  current scale operation started. UI uses (now - scalingSince) plus the
   *  CreateHsm/DeleteHsm cost model to render an "약 N분 남음" ETA. */
  scalingSince?: string;
  /** ISO timestamp of when this snapshot was taken. */
  updatedAt: string;
}

const REGION = process.env.AWS_REGION ?? 'ap-northeast-2';
const ssm = new SSMClient({ region: REGION });
const hsm = new CloudHSMV2Client({ region: REGION });

/** Read /hsm-bmt/core/cluster-state SSM. Returns 'unknown' on any failure. */
export async function readClusterState(): Promise<'idle' | 'scaling' | 'unknown'> {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: '/hsm-bmt/core/cluster-state' }));
    const v = r.Parameter?.Value;
    if (v === 'idle' || v === 'scaling') return v;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Read ACTIVE HSM count via cloudhsmv2:DescribeClusters. */
export async function readActiveHsmCount(): Promise<number> {
  const cid = await readSsm('/hsm-bmt/core/cluster-id');
  if (!cid) return 0;
  const r = await hsm.send(new DescribeClustersCommand({ Filters: { clusterIds: [cid] } }));
  const cluster = r.Clusters?.[0];
  if (!cluster?.Hsms) return 0;
  return cluster.Hsms.filter((h: { State?: string }) => h.State === 'ACTIVE').length;
}

/** Compute the cluster size required to *start* a scenario. */
export function computeRequiredStartHsmCount(
  scenario: { requiredStartHsmCount: number | 'maxOfClusterSizes' } | undefined,
  matrix: { clusterSizes: number[] },
): number {
  if (!scenario) {
    // Unknown scenario id (e.g. legacy DDB row). Fall back to max of clusterSizes.
    return Math.max(...matrix.clusterSizes, 2);
  }
  if (typeof scenario.requiredStartHsmCount === 'number') return scenario.requiredStartHsmCount;
  return Math.max(...matrix.clusterSizes, 2);
}

/** Aggregate read of all the SSM + cloudhsmv2 state needed to render the UI badge. */
export async function readClusterStatus(): Promise<ClusterStatus> {
  const updatedAt = new Date().toISOString();
  let cid = '';
  let desiredCount = 6;
  let clusterState: 'idle' | 'scaling' | 'unknown' = 'unknown';
  let hardScaleStatus: 'ok' | 'degraded' | 'unknown' = 'unknown';
  let stateSince: string | undefined;
  let stateTarget: number | undefined;

  try {
    const r = await ssm.send(
      new GetParametersCommand({
        Names: [
          '/hsm-bmt/core/cluster-id',
          '/hsm-bmt/core/desired-hsm-count',
          '/hsm-bmt/core/cluster-state',
          '/hsm-bmt/core/cluster-state-since',
          '/hsm-bmt/core/cluster-state-target',
          '/hsm-bmt/core/hard-scale-status',
        ],
      }),
    );
    for (const p of r.Parameters ?? []) {
      switch (p.Name) {
        case '/hsm-bmt/core/cluster-id':
          cid = p.Value ?? '';
          break;
        case '/hsm-bmt/core/desired-hsm-count':
          desiredCount = Number(p.Value) || 6;
          break;
        case '/hsm-bmt/core/cluster-state':
          if (p.Value === 'idle' || p.Value === 'scaling') clusterState = p.Value;
          break;
        case '/hsm-bmt/core/cluster-state-since':
          stateSince = p.Value;
          break;
        case '/hsm-bmt/core/cluster-state-target':
          if (p.Value && /^\d+$/.test(p.Value)) stateTarget = Number(p.Value);
          break;
        case '/hsm-bmt/core/hard-scale-status':
          if (p.Value === 'ok' || p.Value === 'degraded') hardScaleStatus = p.Value;
          break;
      }
    }
  } catch {
    // SSM unavailable — return unknown
    return {
      activeCount: 0, totalHsms: 0, desiredCount, states: [],
      clusterState, hardScaleStatus, uiState: 'unknown', updatedAt,
    };
  }

  if (!cid) {
    return {
      activeCount: 0, totalHsms: 0, desiredCount, states: [],
      clusterState, hardScaleStatus, uiState: 'unknown', updatedAt,
    };
  }

  let activeCount = 0;
  let totalHsms = 0;
  let states: string[] = [];
  try {
    const r = await hsm.send(new DescribeClustersCommand({ Filters: { clusterIds: [cid] } }));
    const cluster = r.Clusters?.[0];
    if (cluster?.Hsms) {
      states = cluster.Hsms.map((h) => h.State ?? 'UNKNOWN');
      activeCount = states.filter((s) => s === 'ACTIVE').length;
      totalHsms = states.length;
    }
  } catch {
    return {
      activeCount: 0, totalHsms: 0, desiredCount, states: [],
      clusterState, hardScaleStatus, uiState: 'unknown', updatedAt,
    };
  }

  // uiState derivation:
  //   scaling   — SSM lock says 'scaling' AND age < STALE_TTL_MIN
  //   stale     — scaling AND age > STALE_TTL_MIN (Phase E)
  //   unknown   — SSM/cloudhsmv2 read failed (handled above)
  //   idle      — clusterState=idle AND ACTIVE count == desired
  //   degraded  — clusterState=idle AND ACTIVE count != desired
  let uiState: UiState;
  let staleAgeMinutes: number | undefined;
  if (clusterState === 'scaling') {
    const sinceMs = stateSince ? Date.parse(stateSince) : NaN;
    if (Number.isFinite(sinceMs)) {
      const ageMin = (Date.now() - sinceMs) / 60_000;
      if (ageMin > STALE_TTL_MIN) {
        uiState = 'stale';
        staleAgeMinutes = Math.floor(ageMin);
      } else {
        uiState = 'scaling';
      }
    } else {
      // since timestamp missing/invalid — be conservative, show scaling
      uiState = 'scaling';
    }
  } else if (clusterState === 'unknown') uiState = 'unknown';
  else if (activeCount === desiredCount) uiState = 'idle';
  else uiState = 'degraded';

  return {
    activeCount,
    totalHsms,
    desiredCount,
    states,
    ...(uiState === 'stale' && stateSince ? { staleSince: stateSince, staleAgeMinutes } : {}),
    ...(uiState === 'scaling' && stateSince ? { scalingSince: stateSince } : {}),
    ...((uiState === 'scaling' || uiState === 'stale') && stateTarget !== undefined
        ? { scalingTarget: stateTarget } : {}),
    clusterState,
    hardScaleStatus,
    uiState,
    updatedAt,
  };
}

async function readSsm(name: string): Promise<string> {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name }));
    return r.Parameter?.Value ?? '';
  } catch {
    return '';
  }
}
