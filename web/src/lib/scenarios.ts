/**
 * BMT scenarios — HARD-only edition (HOS-Step8, 2026-05-25).
 *
 * Logical (soft scale), V3 family, and us-west-2 multi-cluster scenarios
 * are retired. The live scenario set is:
 *   1. Smoke              — small 4-cell HARD smoke at cs=6 (~31 min)
 *   2. PER_CALL · Full    — HSM-adaptive procs, hard sweep cs=6→2 (~12h)
 *   3. PER_CALL · Partial — single user-selected cluster size, single pass
 *   4. Custom             — operator-defined matrix; always HARD
 *
 * All scenarios run with hardScale=true (DeleteHsm/CreateHsm changes
 * actual HSM count, not soft cfg toggle). Auto-reset on completion is
 * deprecated — the cluster stays at whatever size the run ended at and
 * the next run's PreFlight prompts the operator to provision if needed.
 */
import { MatrixSubset, countUnits } from './matrix';

export interface Scenario {
  id: string;
  name: string;
  description: string;
  accent: 'teal' | 'cyan' | 'violet' | 'magenta' | 'amber' | 'lime' | 'rose';
  matrix: MatrixSubset;
  /** Partial scenarios require a single cluster size to be chosen at /runs/new. */
  partialClusterSizeRequired?: boolean;
  /** ACTIVE HSM count required to start the scenario.
   *  Number = constant (e.g. 6).
   *  'maxOfClusterSizes' = max(matrix.clusterSizes) — used by Custom. */
  requiredStartHsmCount: number | 'maxOfClusterSizes';
  /** Default reset target if the operator chooses to scale back after the run.
   *  Auto-reset is deprecated; this is only consulted by the manual
   *  "Restore to N" button on HsmStatusBadge. */
  resetToOnExit?: number;
}

const ALL_PAYLOADS: MatrixSubset['payloadBytes'] = [256, 1024];
const FULL_SWEEP_SIZES: MatrixSubset['clusterSizes'] = [6, 5, 4, 3, 2];
const ALL_ALGOS:    MatrixSubset['algorithms']   = ['AES_128', 'AES_256'];
const ALL_MODES:    MatrixSubset['modes']        = ['ECB', 'CBC', 'CTR', 'GCM', 'CMAC'];

/** HSM-adaptive procs sweet-spot (5/19 cluster-sat-results.csv). */
const PER_CALL_PROCS_BY_CLUSTER: Record<number, number> = {
  6: 12,
  5: 12,
  4: 10,
  3: 8,
  2: 6,
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'smoke',
    name: 'Smoke',
    description:
      '리포트 / 대시보드 동작 확인용 작은 multi-proc 테스트. ' +
      'AES-128 × ECB·GCM × 256·1024B × cluster=6 × procs=4. ' +
      '4 cell × 6분 ≈ 26분 + hard-scale stabilize 5분 ≈ 31분.',
    accent: 'lime',
    requiredStartHsmCount: 6,
    resetToOnExit: 6,
    matrix: {
      families: ['PER_CALL_RAW'],
      algorithms: ['AES_128'],
      modes: ['ECB', 'GCM'],
      payloadBytes: [256, 1024],
      clusterSizes: [6],
      variants: [],
      runner: 'c-native-multiproc',
      procs: 4,
      autoScale: false,
      hardScale: true,
    },
  },
  {
    id: 'per-call-full-hard',
    name: 'PER_CALL · Full',
    description:
      'AES-128/256 × ECB·CBC·CTR·GCM·CMAC × 256/1024B × cluster 6→5→4→3→2 hard sweep. ' +
      '실 HSM 갯수를 줄이며 측정. ' +
      'HSM 갯수별 sweet-spot procs 자동 적용 ' +
      '(c=6→p=12, c=5→p=12, c=4→p=10, c=3→p=8, c=2→p=6 — 5/19 saturation 데이터 기반). ' +
      '100 unit, ~12시간 (자동 reset 폐기 — 종료 시 cs=2 유지).',
    accent: 'cyan',
    requiredStartHsmCount: 6,
    resetToOnExit: 6,
    matrix: {
      families: ['PER_CALL_RAW'],
      algorithms: ALL_ALGOS,
      modes: ALL_MODES,
      payloadBytes: ALL_PAYLOADS,
      clusterSizes: FULL_SWEEP_SIZES,
      variants: [],
      runner: 'c-native-multiproc',
      procs: 8,
      procsByCluster: PER_CALL_PROCS_BY_CLUSTER,
      autoScale: true,
      hardScale: true,
    } as MatrixSubset,
  },
  {
    id: 'per-call-partial-hard',
    name: 'PER_CALL · Partial',
    description:
      '20 cell 매트릭스, 단일 cluster size (운영자 선택). ' +
      '시작 시 cs=6 에서 선택 size 까지 HSM 실제 delete, 측정 후 그 사이즈 유지. ' +
      '256B는 procs=4, 1024B는 procs=2.',
    accent: 'amber',
    partialClusterSizeRequired: true,
    requiredStartHsmCount: 6,
    resetToOnExit: 6,
    matrix: {
      families: ['PER_CALL_RAW'],
      algorithms: ALL_ALGOS,
      modes: ALL_MODES,
      payloadBytes: ALL_PAYLOADS,
      clusterSizes: [6],
      variants: [],
      runner: 'c-native-multiproc',
      procs: 4,
      autoScale: false,
      hardScale: true,
      procs256: 4,
      procs1024: 2,
    } as MatrixSubset,
  },
  {
    id: 'custom-hard',
    name: 'Custom',
    description:
      '운영자 정의 매트릭스. 단일 size 선택 시 단일 패스, 다중 size 선택 시 sweep. ' +
      '실 HSM 갯수 변동 (cloudhsmv2 DeleteHsm/CreateHsm). ' +
      'HSM 갯수별 sweet-spot procs 자동 적용 (Full HARD 와 동일). ' +
      '종료 시 마지막 size 그대로 유지.',
    accent: 'magenta',
    requiredStartHsmCount: 'maxOfClusterSizes',
    resetToOnExit: 6,
    // 2026-05-26: this is a TEMPLATE used to seed Custom-HARD runs from
    // /runs/new — MatrixSelector emit does NOT carry procs/procsByCluster
    // (the operator UI doesn't expose those axes), so start() merges these
    // fields into the effective matrix before posting to start-run. Without
    // this merge the run lands with procs=1 and dramatically
    // under-saturates the HSM (observed 2026-05-26: cs=3 measured
    // 12,271 ops/s vs expected ~21,316 at procs=8).
    matrix: {
      families: ['PER_CALL_RAW'],
      algorithms: ALL_ALGOS,
      modes: ALL_MODES,
      payloadBytes: ALL_PAYLOADS,
      clusterSizes: [6],
      variants: [],
      runner: 'c-native-multiproc',
      procs: 8,
      procsByCluster: PER_CALL_PROCS_BY_CLUSTER,
      autoScale: false,
      hardScale: true,
    } as MatrixSubset,
  },
];

export const scenarioUnitCount = (s: Scenario): number => countUnits(s.matrix);

export function expandScenarioToQueueItems(s: Scenario):
    Array<{ scenarioId: string; scenarioName: string; matrix: MatrixSubset }> {
  return [{ scenarioId: s.id, scenarioName: s.name, matrix: s.matrix }];
}

/** Compute the ACTIVE HSM count required to start a scenario. */
export function requiredStartHsmCountFor(s: Scenario, matrix?: MatrixSubset): number {
  const m = matrix ?? s.matrix;
  if (typeof s.requiredStartHsmCount === 'number') return s.requiredStartHsmCount;
  return Math.max(...m.clusterSizes, 2);
}
