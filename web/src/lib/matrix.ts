/**
 * Shared matrix types + helpers used by Run authoring, clone, and retry flows.
 * Keep aligned with web-api/src/lib/types.ts (server-side validator).
 */

export type Family = 'V3' | 'PER_CALL' | 'PER_CALL_RAW';
export type Algorithm = 'AES_128' | 'AES_256';
export type Mode = 'ECB' | 'CBC' | 'CTR' | 'GCM' | 'CMAC';
export type Payload = 256 | 1024;
export type ClusterSize = 2 | 3 | 4 | 5 | 6;
export type Variant = 'A' | 'B';
// 2026-05-25 HOS: Region type retired — single-region (ap-northeast-2).
// Family V3 / PER_CALL kept for legacy DDB row compatibility but server
// rejects them at start-run time.

/**
 * Selects which loader path the orchestrator drives:
 *   - 'java-jvm'           — single Java BmtMain (legacy / Custom)
 *   - 'java-multiproc'     — N concurrent Java BmtMain instances (PER_CALL Full/Partial)
 *   - 'c-native-multiproc' — N concurrent /tmp/v3_bench processes (V3 Full/Partial)
 */
export type Runner = 'java-jvm' | 'java-multiproc' | 'c-native-multiproc';

export interface MatrixSubset {
  families: Family[];
  algorithms: Algorithm[];
  modes: Mode[];
  payloadBytes: Payload[];
  clusterSizes: ClusterSize[];
  variants: Variant[];
  /** Loader path. Optional: if absent, web-api defaults to 'java-jvm' for backwards compat. */
  runner?: Runner;
  /** Concurrent loader processes (multi-proc runners). Default 1. */
  procs?: number;
  /** If true, orchestrator iterates clusterSizes [6,5,4,3,2] sequentially with
   *  scale-cluster.sh between passes. If false, single pass at clusterSizes[0]. */
  autoScale?: boolean;
  /** PER_CALL c-native only: differential fan-out per payload. 1024B mesh-
   *  replication is ~4x heavier than 256B; tuning procs per payload keeps
   *  each cell inside the 6-min window while preserving plateau measurement. */
  procs256?: number;
  procs1024?: number;
  /** PER_CALL Full sweep: procs override per cluster size. Saturation data
   *  (5/19 cluster-sat-results.csv) showed sweet-spot procs varies by HSM
   *  count — orchestrator looks up `procsByCluster[size]` before each pass
   *  and falls back to `procs` if absent.
   *  Source: customer-handover-plan §"HSM-adaptive procs". */
  procsByCluster?: Record<number, number>;
  /**
   * 2026-05-24 hard scale: when true, the orchestrator's cluster-size sweep
   * actually deletes / creates HSMs (cloudhsmv2:DeleteHsm / CreateHsm) so the
   * cluster mesh size matches the target N — instead of just toggling the
   * loader cfg's enable=true|false (soft scale, mesh stays at desired-hsm-count).
   *
   * Why: 2026-05-24 measurement showed soft cs=N over-estimates throughput
   * vs production HSM-fail (hard) cs=N. Same axis apne2 cs=5 measured
   * soft=1,927 vs hard=1,393 tx/s.
   *
   * Hard scale takes ~10–15 min per HSM delete and ~25 min per create, so a
   * 6→5→4→3→2 sweep + reset is on the order of 3 hours of scale overhead in
   * addition to the measurement time. autoScale must be true for this flag
   * to take effect.
   */
  hardScale?: boolean;
}

export interface UnitLike {
  family: string;
  variant: string;
  algo: string;
  mode: string;
  payload: number;
  clusterSize: number;
  status: string;
}

const uniq = <T>(xs: T[]): T[] => Array.from(new Set(xs));
const isFailed = (s: string): boolean => s === 'FAILED' || s === 'TIMEOUT' || s === 'ABORTED';

/**
 * Reconstruct a MatrixSubset that covers exactly the unit set passed in.
 * Used by both "Clone" (all units) and "Retry failed" (failed-only) flows.
 */
export function matrixFromUnits(units: UnitLike[]): MatrixSubset {
  return {
    families:    uniq(units.map((u) => u.family))      as Family[],
    algorithms:  uniq(units.map((u) => u.algo))        as Algorithm[],
    modes:       uniq(units.map((u) => u.mode).filter((m) => m && m !== '-' && m !== 'N/A')) as Mode[],
    payloadBytes:uniq(units.map((u) => u.payload))     as Payload[],
    clusterSizes:uniq(units.map((u) => u.clusterSize)) as ClusterSize[],
    variants:    uniq(units.map((u) => u.variant).filter((v) => v && v !== '-' && v !== 'N/A')) as Variant[],
  };
}

export function failedUnits<T extends UnitLike>(units: T[]): T[] {
  return units.filter((u) => isFailed(u.status));
}

/** Cardinality estimate identical to the server-side counter. */
export function countUnits(s: MatrixSubset): number {
  let total = 0;
  if (s.families.includes('V3')) {
    total += s.algorithms.length * s.payloadBytes.length * s.clusterSizes.length * Math.max(s.variants.length, 1);
  }
  if (s.families.includes('PER_CALL')) {
    total += s.algorithms.length * Math.max(s.modes.length, 1) * s.payloadBytes.length * s.clusterSizes.length;
  }
  if (s.families.includes('PER_CALL_RAW')) {
    total += s.algorithms.length * Math.max(s.modes.length, 1) * s.payloadBytes.length * s.clusterSizes.length;
  }
  return total;
}
