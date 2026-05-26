// HOS-only: c-native-multiproc is the single supported runner. The Java loader
// path (java-jvm / java-multiproc) and V3 / PER_CALL families were retired
// 2026-05-25 (see hard-only-scenarios-plan.md). Legacy union members are kept
// in the type so existing DDB rows still validate; new runs are gated to
// PER_CALL_RAW + c-native-multiproc by start-run.ts.
export type Runner = 'java-jvm' | 'java-multiproc' | 'c-native-multiproc';

export interface MatrixSubset {
  families: ('V3' | 'PER_CALL' | 'PER_CALL_RAW')[];
  algorithms: ('AES_128' | 'AES_256')[];
  modes: ('ECB' | 'CBC' | 'CTR' | 'GCM' | 'CMAC')[];
  payloadBytes: (256 | 1024)[];
  clusterSizes: (2 | 3 | 4 | 5 | 6)[];
  variants: ('A' | 'B')[];
  /** Loader path; default 'java-jvm' for backwards compatibility. */
  runner?: Runner;
  /** Multi-proc concurrency; only meaningful for *-multiproc runners. Default 1. */
  procs?: number;
  /** If true, orchestrator iterates clusterSizes [6,5,4,3,2] sequentially. */
  autoScale?: boolean;
  /** PER_CALL c-native only: differential procs across payloads (1024B mesh
   *  load is ~4x heavier than 256B; smaller fan-out keeps cell inside the
   *  6-min window). Wrapper reads via HSM_BMT_PROCS_256/_1024 env. */
  procs256?: number;
  procs1024?: number;
}

export interface StartRunInput {
  matrixSubset: MatrixSubset;
  expectedLoaderVersionId: string;
  expectedLoaderSha256: string;
  /**
   * Optional override for the loader's worker count (default = clusterSize × 16).
   * Used by the PER_CALL_RAW saturation sweep. When set, the start-run lambda
   * appends HSM_BMT_WORKER_COUNT=<n> to /etc/hsm-bmt/runner.env before launching
   * the loader.
   */
  workerCount?: number;
}

export interface ApiResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

// API Gateway REST proxy integration accepts only the canonical fields:
// statusCode / headers / multiValueHeaders / body / isBase64Encoded.
// Any extra field (e.g. a `payload` echo) triggers
//   {"message": "Internal server error"} + 502 + no CORS headers.
// Add Access-Control-Allow-Origin here so error responses also satisfy CORS.
export const json = <T>(statusCode: number, payload: T): ApiResponse => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(payload),
});

export const validateMatrixSubset = (s: unknown): s is MatrixSubset => {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (!Array.isArray(o.families) || o.families.length === 0) return false;
  if (!Array.isArray(o.algorithms) || o.algorithms.length === 0) return false;
  if (!Array.isArray(o.payloadBytes) || o.payloadBytes.length === 0) return false;
  if (!Array.isArray(o.clusterSizes) || o.clusterSizes.length === 0) return false;
  if (!Array.isArray(o.modes)) return false;
  if (!Array.isArray(o.variants)) return false;
  // 2026-05-26: PER_CALL family/PER_CALL_RAW always need ≥1 mode.
  // V3 doesn't use modes (already retired), so legacy V3-only runs can
  // still pass with modes=[]. Centralizing the check here matches the
  // start-run.ts contract and prevents Clone/Retry from reaching
  // start-run with an empty modes array under PER_CALL_RAW.
  if (o.families.includes('PER_CALL_RAW') || o.families.includes('PER_CALL')) {
    if ((o.modes as unknown[]).length === 0) return false;
  }
  return true;
};

export const newRunId = (now = new Date()): string => {
  const iso = now.toISOString();
  const stamp = iso.replace(/[-:T.Z]/g, '').slice(0, 14); // yyyymmddhhmmss
  return `rid-${stamp}`;
};
