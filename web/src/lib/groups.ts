/**
 * U-CH-3: id_token claim decode for UI permission hints.
 *
 * The backend custom authorizer (U-CH-1) is the source of truth for
 * authorization — it verifies signature/iss/exp/aud against JWKS and
 * matches groups against the per-method endpoint matrix. This module
 * just decodes the unverified body so the UI can disable buttons that
 * the backend would reject anyway. Tampering only weakens the *hint* —
 * the API call still 403s.
 */

const ID_TOKEN_KEY = 'hsm-bmt-id-token';

export interface ClaimSet {
  username: string;
  groups: string[];
  isAdmin: boolean;
  isViewer: boolean;
}

function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ID_TOKEN_KEY)
      ?? window.sessionStorage.getItem(ID_TOKEN_KEY);
}

function decodeBody(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '==='.slice((padded.length + 3) % 4));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getClaimSet(): ClaimSet | null {
  const tok = readToken();
  if (!tok) return null;
  const body = decodeBody(tok);
  if (!body) return null;
  const username = String(body['cognito:username'] ?? body['sub'] ?? '');
  const rawGroups = body['cognito:groups'];
  const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
  return {
    username,
    groups,
    isAdmin: groups.includes('admin'),
    isViewer: groups.includes('viewer'),
  };
}

export function isAdmin(): boolean {
  return getClaimSet()?.isAdmin ?? false;
}

export function isViewer(): boolean {
  return getClaimSet()?.isViewer ?? false;
}
