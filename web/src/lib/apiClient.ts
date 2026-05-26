/**
 * Thin fetch wrapper. Cognito token is fetched from session storage where the
 * Hosted UI redirect callback persisted it. On 401 we kick the user back to
 * Hosted UI; the SSO cookie usually round-trips silently so it lands back on
 * /callback within a few seconds without a password prompt.
 */

import { login, refreshIdToken, getAccessToken } from './auth';

// API Gateway URL ends with a trailing slash (e.g. "https://.../prod/").
// Strip it so callers can use absolute paths like `/runs` without producing
// `prod//runs` (which API Gateway returns 502/missing-CORS for).
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/+$/, '');

const ID_TOKEN_KEY = 'hsm-bmt-id-token';
const POST_LOGIN_KEY = 'hsm-bmt-post-login-path';
let reauthInFlight = false;

function token(): string | null {
  // U-CH-1: custom REQUEST authorizer requires Cognito access token
  // (carries `custom:sessionId` from PreTokenGen V2). id token is now used
  // only by the optional jwt-decode group lookup in groups.ts.
  return getAccessToken();
}

/** Fired on 401 / network error after a token was present: clear the stale
 *  token, remember where the user was, redirect to Hosted UI. */
function reauthAndRedirect(): void {
  if (reauthInFlight) return;
  reauthInFlight = true;
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(ID_TOKEN_KEY);
  const here = window.location.pathname + window.location.search;
  window.sessionStorage.setItem(POST_LOGIN_KEY, here);
  // Hand off to auth.ts (PKCE start). After exchange callback page picks
  // the saved path back up.
  void login();
}

export function consumePostLoginPath(): string | null {
  if (typeof window === 'undefined') return null;
  const v = window.sessionStorage.getItem(POST_LOGIN_KEY);
  if (v) window.sessionStorage.removeItem(POST_LOGIN_KEY);
  return v;
}

async function fetchOnce(method: string, path: string, body?: unknown): Promise<Response> {
  const tok = token();
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * U-CH-3: parse the GatewayResponse body emitted by U-CH-1 VTL templates.
 *  - 401 session_invalidated → admin was logged out (race window U-CH-1 NFR).
 *    Show alert + redirect to login. Do NOT try refresh — the backend has
 *    already invalidated the sessionId.
 *  - 403 forbidden → viewer hit an admin endpoint. Show alert (no redirect).
 *  - other 401 (legacy "unauthorized") → existing refresh-and-retry path.
 */
interface AuthorizerErrorBody { error?: string; reason?: string }
async function parseAuthErrorBody(res: Response): Promise<AuthorizerErrorBody> {
  try { return JSON.parse(await res.text()) as AuthorizerErrorBody; }
  catch { return {}; }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const hadToken = !!token();
  let res: Response;
  try {
    res = await fetchOnce(method, path, body);
  } catch (e) {
    // Network/CORS — API Gateway 401 strips CORS, surfaces as TypeError.
    // Try a refresh-and-retry once before giving up to interactive login.
    if (hadToken && await refreshIdToken()) {
      try { res = await fetchOnce(method, path, body); }
      catch { reauthAndRedirect(); throw new Error('세션이 만료되어 재로그인합니다…'); }
    } else if (hadToken) {
      reauthAndRedirect();
      throw new Error('세션이 만료되어 재로그인합니다…');
    } else {
      throw e;
    }
  }
  // U-CH-3: 403 forbidden — viewer attempted admin action.
  // Do NOT pop a global alert — that would fire on every background poll
  // (e.g. listRuns 8s loop on the overview page) and spam the user. Each
  // mutating action call site that explicitly invokes a privileged
  // endpoint is responsible for surfacing this `Error` via its own catch.
  // GET endpoints handled by the standard error UI.
  if (res.status === 403) {
    const eb = await parseAuthErrorBody(res);
    const msg = eb.reason ?? '권한이 없습니다.';
    throw new Error(`forbidden: ${msg}`);
  }
  if (res.status === 401 && hadToken) {
    const eb = await parseAuthErrorBody(res);
    // U-CH-3 / AC-1: same-account login from another browser → backend rotated
    // sessionId, this token is now stale. No refresh-retry — Cognito would
    // just reissue the same stale sid. Force interactive re-login.
    if (eb.error === 'session_invalidated') {
      // FR-CH-2.4: backend authorizer always emits this exact string in `reason`;
      // the fallback below covers the contract-violating-server case only.
      const msg = eb.reason
        ?? '다른 위치에서 로그인되어 자동 로그아웃됩니다.';
      if (typeof window !== 'undefined') window.alert(msg);
      reauthAndRedirect();
      throw new Error(msg);
    }
    if (await refreshIdToken()) {
      res = await fetchOnce(method, path, body);
      if (res.status === 401) {
        reauthAndRedirect();
        throw new Error('세션이 만료되어 재로그인합니다…');
      }
    } else {
      reauthAndRedirect();
      throw new Error('세션이 만료되어 재로그인합니다…');
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(humanizeError(res.status, text));
  }
  return res.json() as Promise<T>;
}

/**
 * Map structured backend error bodies (start-run / cluster-provision / locks)
 * to a human-readable Korean string. Falls back to the raw status+body when
 * the response isn't structured JSON or the error key isn't recognised — so
 * unexpected errors are still visible during debugging.
 *
 * Why: backend lambdas already produce well-shaped JSON like
 *   { error: "cluster_not_ready", current: 3, required: 6, hint: "..." }
 * Without this mapping the UI was surfacing the JSON literal verbatim
 * (observed 2026-05-26: "HTTP 422: {\"error\":\"cluster_not_ready\",...}"),
 * which forces the operator to mentally JSON-parse an alert dialog.
 */
function humanizeError(status: number, text: string): string {
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  const code = typeof body.error === 'string' ? body.error : '';
  // 401 (status) MUST always emit an auth-marker message that downstream
  // components (HsmStatusBadge, PreFlightPanel) match on the words "재로그인"
  // or "만료" to silently fall back to authed=false instead of rendering a
  // red error chip. Without this branch a 401 that dodges request()'s
  // dedicated 401 handler (e.g. when a token is briefly null between fetch
  // and refresh) would surface as the literal "인증 실패" string from the
  // authorizer, which has neither word — observed 2026-05-26: red chip
  // "🔴 HSM API 오류" appearing on otherwise healthy clusters.
  if (status === 401) {
    return '세션이 만료되어 재로그인합니다…';
  }
  switch (code) {
    case 'cluster_not_ready':
      return `클러스터가 cs=${body.current}대 상태입니다. 시작에 cs=${body.required}대 필요 — 먼저 프로비저닝하세요.`;
    case 'cluster_scaling_in_progress':
      return '클러스터 스케일링 중입니다. 완료 후 다시 시도하세요.';
    case 'cluster_state_unknown':
      return '클러스터 상태를 읽을 수 없습니다 (SSM/HSM API 일시 장애?). 잠시 후 다시 시도하세요.';
    case 'another run is already in progress':
      return `다른 Run이 진행 중입니다${body.activeRunId ? ` (${body.activeRunId})` : ''}. 종료 후 시도하세요.`;
    default:
      // Preserve structured 'reason' if present (custom authorizer 403 path).
      if (typeof body.reason === 'string') return body.reason;
      // Preserve a plain { error: "..." } shape for generic 4xx misuse.
      if (code) return code;
      return `HTTP ${status}: ${text}`;
  }
}

export interface RunSummary {
  runId: string;
  status: string;
  startedAt: string;
  completedUnits: number;
  totalUnits: number;
  createdBy: string;
  matrixSubset?: import('./matrix').MatrixSubset;
  expectedLoaderVersionId?: string;
  expectedLoaderSha256?: string;
}

export interface UnitRow {
  unitId: string;
  family: string;
  variant: string;
  algo: string;
  mode: string;
  payload: number;
  clusterSize: number;
  status: string;
  opsPerSec?: number;
  p99Ns?: number;
}

export interface LoaderInfo {
  versionId: string | null;
  sha256: string | null;
}

export interface ClusterStatus {
  activeCount: number;
  totalHsms: number;
  desiredCount: number;
  states: string[];
  clusterState: 'idle' | 'scaling' | 'unknown';
  hardScaleStatus: 'ok' | 'degraded' | 'unknown';
  uiState: 'idle' | 'degraded' | 'scaling' | 'stale' | 'unknown';
  staleSince?: string;
  staleAgeMinutes?: number;
  scalingTarget?: number;
  /** ISO timestamp of when the in-flight scale operation began.
   *  Populated only when uiState='scaling'. UI uses (now - scalingSince)
   *  + the per-HSM cost model to render an ETA. */
  scalingSince?: string;
  updatedAt: string;
}

export interface ProvisionResp {
  status: 'started' | 'noop' | string;
  current?: number;
  target?: number;
  estimatedMinutes?: number;
  commandId?: string;
}

export const api = {
  loaderInfo: () => request<LoaderInfo>('GET', '/loader-info'),
  listRuns: () => request<{ runs: RunSummary[] }>('GET', '/runs'),
  startRun: (input: unknown) => request<{ runId: string; status: string }>('POST', '/runs', input),
  abortRun: (runId: string) => request<{ runId: string; status: string }>('POST', `/runs/${runId}/abort`),
  getRun: (runId: string) => request<{ run: RunSummary; units: UnitRow[] }>('GET', `/runs/${runId}`),
  getRunStatus: (runId: string) =>
    request<{
      runId: string;
      status: string;
      completed: number;
      total: number;
      etaUtc: string | null;
      completedAt?: string | null;
    }>('GET', `/runs/${runId}/status`),
  reportHtmlUrl: (runId: string) => request<{ status?: 'READY' | 'NOT_READY'; url?: string; message?: string }>('GET', `/reports/${runId}`),
  reportPdfUrl: (runId: string) => request<{ status?: 'READY' | 'NOT_READY'; url?: string; message?: string }>('GET', `/reports/${runId}/pdf`),
  getClusterStatus: () => request<ClusterStatus>('GET', '/cluster/status'),
  provisionCluster: (targetCount: number) =>
    request<ProvisionResp>('POST', '/cluster/provision', { targetCount }),
  // Phase F (cluster-state-rca-plan): admin-only emergency unlock.
  forceUnlockCluster: () =>
    request<{ status: string; previousState: string; clearedAt: string }>(
      'POST', '/cluster/force-unlock'),
};
