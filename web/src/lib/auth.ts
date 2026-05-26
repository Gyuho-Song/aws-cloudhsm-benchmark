/**
 * Cognito Hosted UI integration for the static SPA.
 *
 * Token policy:
 *   - id/access tokens: 24h (Cognito hard maximum)
 *   - refresh token:    10y (Cognito hard maximum)
 *   - id_token + refresh_token persisted in localStorage so closing the tab
 *     doesn't drop the session.
 *   - Background refresh runs ~5 min before id_token expiry; if the refresh
 *     call fails we fall through to interactive login on the next 401.
 */

const DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? '';
const REGION = process.env.NEXT_PUBLIC_COGNITO_REGION ?? '';
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? '';
const CLOUDFRONT = process.env.NEXT_PUBLIC_CLOUDFRONT_DOMAIN ?? '';

const HOSTED_UI = `https://${DOMAIN}.auth.${REGION}.amazoncognito.com`;
const CALLBACK = `https://${CLOUDFRONT}/callback`;
const LOGOUT = `https://${CLOUDFRONT}/logout`;

const ID_TOKEN_KEY = 'hsm-bmt-id-token';
const ACCESS_TOKEN_KEY = 'hsm-bmt-access-token';
const REFRESH_TOKEN_KEY = 'hsm-bmt-refresh-token';
const TOKEN_EXP_KEY = 'hsm-bmt-token-exp';
const VERIFIER_KEY = 'hsm-bmt-pkce-verifier';

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const verifier = b64url(arr.buffer);
  const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(hashed) };
}

function persist(idToken: string, accessToken: string, refreshToken: string | undefined, expiresInSec: number) {
  if (typeof window === 'undefined') return;
  // Stored in localStorage so a browser tab close doesn't lose the session.
  // Mirrored to sessionStorage for backward-compat with apiClient.ts.
  window.localStorage.setItem(ID_TOKEN_KEY, idToken);
  window.sessionStorage.setItem(ID_TOKEN_KEY, idToken);
  // U-CH-1: custom REQUEST authorizer requires access token (carries
  // `custom:sessionId` claim from PreTokenGen V2 trigger). Frontend now
  // sends access token as Bearer; id token kept only for the legacy
  // jwt-decode group lookup path (groups.ts).
  window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  window.sessionStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) {
    window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
  const expAt = Date.now() + expiresInSec * 1000;
  window.localStorage.setItem(TOKEN_EXP_KEY, String(expAt));
}

export function getIdToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ID_TOKEN_KEY)
      ?? window.sessionStorage.getItem(ID_TOKEN_KEY);
}

/** U-CH-1: access token used by API requests (Bearer). Falls back to
 *  id token if access not present (backwards-compat with previously stored
 *  sessions from before this change). */
export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY)
      ?? window.sessionStorage.getItem(ACCESS_TOKEN_KEY)
      ?? getIdToken();
}

function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

function getExpiry(): number {
  if (typeof window === 'undefined') return 0;
  return Number(window.localStorage.getItem(TOKEN_EXP_KEY) ?? 0);
}

export async function login(): Promise<void> {
  const { verifier, challenge } = await pkce();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const url = new URL(`${HOSTED_UI}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', CALLBACK);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(url.toString());
}

export async function silentLogin(): Promise<void> {
  return login();
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('PKCE verifier missing');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
  });
  const res = await fetch(`${HOSTED_UI}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  persist(data.id_token, data.access_token, data.refresh_token, data.expires_in);
  sessionStorage.removeItem(VERIFIER_KEY);
}

/** Refresh the id_token using the stored refresh_token. Returns false on failure. */
export async function refreshIdToken(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return false;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: rt,
  });
  try {
    const res = await fetch(`${HOSTED_UI}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      id_token: string;
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    // Cognito returns no new refresh_token on refresh; reuse the existing one.
    persist(data.id_token, data.access_token, data.refresh_token ?? rt, data.expires_in);
    return true;
  } catch {
    return false;
  }
}

/** Schedule background refresh ~5 min before expiry. Idempotent — call on app load. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleRefresh(): void {
  if (typeof window === 'undefined') return;
  if (refreshTimer) clearTimeout(refreshTimer);
  const exp = getExpiry();
  if (!exp) return;
  const msUntilRefresh = Math.max(10_000, exp - Date.now() - 5 * 60_000);
  refreshTimer = setTimeout(async () => {
    const ok = await refreshIdToken();
    if (ok) scheduleRefresh();
  }, msUntilRefresh);
}

export function logout(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(ID_TOKEN_KEY);
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    window.localStorage.removeItem(TOKEN_EXP_KEY);
    window.sessionStorage.removeItem(ID_TOKEN_KEY);
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  }
  const url = new URL(`${HOSTED_UI}/logout`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('logout_uri', LOGOUT);
  window.location.assign(url.toString());
}

export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;
  return !!getIdToken();
}
