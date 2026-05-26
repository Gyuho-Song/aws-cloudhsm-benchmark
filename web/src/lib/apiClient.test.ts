/**
 * U-CH-3 COMP-CH-8: 401 response body parsing for session_invalidated /
 * forbidden / precondition_failed branches.
 *
 * Backend (U-CH-1 GatewayResponse VTL) emits:
 *   401 { error: "session_invalidated" | "unauthorized" | "precondition_failed", reason: "..." }
 *   403 { error: "forbidden", reason: "..." }
 *
 * We assert the *behavior*: was login() invoked or not? was an alert shown?
 */
export {};

const ID_TOKEN_KEY = 'hsm-bmt-id-token';
const REFRESH_TOKEN_KEY = 'hsm-bmt-refresh-token';

let loginCalls = 0;
let refreshOk = false;
const alertCalls: string[] = [];

jest.mock('./auth', () => ({
  login: jest.fn(async () => { loginCalls += 1; }),
  refreshIdToken: jest.fn(async () => refreshOk),
  getIdToken: () => window.localStorage.getItem('hsm-bmt-id-token'),
  getAccessToken: () => window.localStorage.getItem('hsm-bmt-id-token'),
}));

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  loginCalls = 0;
  refreshOk = false;
  alertCalls.length = 0;
  (global as { fetch?: unknown }).fetch = undefined;
  (window as unknown as { alert: (msg: string) => void }).alert =
    (msg: string) => { alertCalls.push(msg); };
  jest.resetModules();
});

function mockFetchSequence(responses: Array<Partial<Response> & { _body?: string }>): jest.Mock {
  let i = 0;
  const fn = jest.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      json: async () => JSON.parse(r._body ?? '{}'),
      text: async () => r._body ?? '',
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

test('401 session_invalidated → alert + redirect to login (no refresh attempt)', async () => {
  window.localStorage.setItem(ID_TOKEN_KEY, 'stale-token');
  window.localStorage.setItem(REFRESH_TOKEN_KEY, 'rt');
  mockFetchSequence([{
    status: 401,
    _body: JSON.stringify({
      error: 'session_invalidated',
      reason: '다른 위치에서 로그인되어 자동 로그아웃됩니다.',
    }),
  }]);
  refreshOk = true;  // even if refresh would succeed, we should NOT use it
  const { api } = await import('./apiClient');
  await expect(api.listRuns()).rejects.toThrow();
  expect(loginCalls).toBe(1);
  // FR-CH-2.4 exact wording
  expect(alertCalls.some(m => m.includes('다른 위치에서 로그인되어 자동 로그아웃됩니다.'))).toBe(true);
});

test('403 forbidden → throws Error, NO global alert + NO redirect', async () => {
  window.localStorage.setItem(ID_TOKEN_KEY, 'viewer-token');
  mockFetchSequence([{
    status: 403,
    _body: JSON.stringify({ error: 'forbidden', reason: '조회 권한입니다. 실행 권한이 필요합니다.' }),
  }]);
  const { api } = await import('./apiClient');
  // Caller (the action's onClick handler) catches and shows the message
  // inline; apiClient itself must not pop window.alert (would spam during
  // background polls).
  await expect(api.startRun({})).rejects.toThrow(/forbidden/);
  expect(loginCalls).toBe(0);
  expect(alertCalls.length).toBe(0);
});

test('401 unauthorized (legacy) still tries refresh once', async () => {
  window.localStorage.setItem(ID_TOKEN_KEY, 'token-a');
  window.localStorage.setItem(REFRESH_TOKEN_KEY, 'rt');
  refreshOk = true;
  mockFetchSequence([
    { status: 401, _body: '{"error":"unauthorized"}' },
    { status: 200, _body: '{"runs":[]}' },
  ]);
  const { api } = await import('./apiClient');
  await expect(api.listRuns()).resolves.toEqual({ runs: [] });
  expect(loginCalls).toBe(0);
});

test('happy path 200 returns parsed json', async () => {
  window.localStorage.setItem(ID_TOKEN_KEY, 't');
  mockFetchSequence([{ status: 200, _body: '{"runs":[{"runId":"rid-1"}]}' }]);
  const { api } = await import('./apiClient');
  const r = await api.listRuns();
  expect(r.runs[0].runId).toBe('rid-1');
});
