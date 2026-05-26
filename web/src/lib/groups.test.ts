/**
 * U-CH-3: groups.ts — JWT id_token claim decode for UI permission hints.
 * Backend authorizer is the source of truth; frontend uses these for UX only.
 */
export {};

const ID_TOKEN_KEY = 'hsm-bmt-id-token';

function makeIdToken(claims: object): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=+$/, '');
  const body = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${header}.${body}.signature-not-checked-by-frontend`;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('getClaimSet', () => {
  test('returns null when no token stored', async () => {
    const { getClaimSet } = await import('./groups');
    expect(getClaimSet()).toBeNull();
  });

  test('decodes admin group from cognito:groups claim', async () => {
    window.localStorage.setItem(ID_TOKEN_KEY, makeIdToken({
      'cognito:username': 'test-admin',
      'cognito:groups': ['admin'],
    }));
    const { getClaimSet } = await import('./groups');
    const c = getClaimSet();
    expect(c).not.toBeNull();
    expect(c!.username).toBe('test-admin');
    expect(c!.groups).toEqual(['admin']);
    expect(c!.isAdmin).toBe(true);
    expect(c!.isViewer).toBe(false);
  });

  test('decodes viewer group', async () => {
    window.localStorage.setItem(ID_TOKEN_KEY, makeIdToken({
      'cognito:username': 'test-viewer-1',
      'cognito:groups': ['viewer'],
    }));
    const { getClaimSet } = await import('./groups');
    const c = getClaimSet();
    expect(c!.isAdmin).toBe(false);
    expect(c!.isViewer).toBe(true);
  });

  test('handles missing cognito:groups (treats as viewer for safety)', async () => {
    window.localStorage.setItem(ID_TOKEN_KEY, makeIdToken({
      'cognito:username': 'no-group-user',
    }));
    const { getClaimSet } = await import('./groups');
    const c = getClaimSet();
    expect(c!.groups).toEqual([]);
    expect(c!.isAdmin).toBe(false);
    expect(c!.isViewer).toBe(false);
  });

  test('returns null on malformed token', async () => {
    window.localStorage.setItem(ID_TOKEN_KEY, 'not-a-jwt');
    const { getClaimSet } = await import('./groups');
    expect(getClaimSet()).toBeNull();
  });

  test('admin in multi-group claim still detected', async () => {
    window.localStorage.setItem(ID_TOKEN_KEY, makeIdToken({
      'cognito:username': 'mixed',
      'cognito:groups': ['admin', 'something-else'],
    }));
    const { getClaimSet } = await import('./groups');
    expect(getClaimSet()!.isAdmin).toBe(true);
  });
});

describe('isAdmin / isViewer convenience', () => {
  test('returns false for both when not authenticated', async () => {
    const { isAdmin, isViewer } = await import('./groups');
    expect(isAdmin()).toBe(false);
    expect(isViewer()).toBe(false);
  });

  test('isAdmin true / isViewer false for admin user', async () => {
    window.localStorage.setItem(ID_TOKEN_KEY, makeIdToken({
      'cognito:username': 'a',
      'cognito:groups': ['admin'],
    }));
    const { isAdmin, isViewer } = await import('./groups');
    expect(isAdmin()).toBe(true);
    expect(isViewer()).toBe(false);
  });
});
