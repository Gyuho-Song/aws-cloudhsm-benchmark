import {
  truncateUtf8,
  denyPolicy,
  parseMethodArn,
  matchesEndpoint,
  decodeGroups,
} from '../src/lib/auth';

describe('truncateUtf8', () => {
  it('passes ASCII string under maxBytes through unchanged', () => {
    expect(truncateUtf8('hello', 256)).toBe('hello');
  });

  it('truncates Korean multibyte string at byte boundary without breaking codepoints', () => {
    // Each Hangul char is 3 UTF-8 bytes. 100 chars = 300 bytes. With maxBytes=256
    // → expect 85 chars (255 bytes) or 86 chars (258 bytes — over). Algo picks
    // largest prefix ≤ 256. 256/3 = 85.33 → 85 chars = 255 bytes.
    const input = '가'.repeat(100);
    const out = truncateUtf8(input, 256);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(256);
    // result must still decode cleanly (no broken char)
    expect(out).toBe('가'.repeat(85));
  });

  it('handles empty / nullish input defensively', () => {
    expect(truncateUtf8('', 256)).toBe('');
    expect(truncateUtf8(null as unknown as string, 256)).toBe('');
    expect(truncateUtf8(undefined as unknown as string, 256)).toBe('');
  });
});

describe('denyPolicy', () => {
  it('returns IAM Deny policy with error/reason context', () => {
    const result = denyPolicy(
      'arn:aws:execute-api:ap-northeast-2:123:api/prod/POST/runs',
      'forbidden',
      '이 작업은 admin 권한이 필요합니다.'
    );
    expect(result).toEqual({
      principalId: 'unknown',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Deny',
          Action: 'execute-api:Invoke',
          Resource: 'arn:aws:execute-api:ap-northeast-2:123:api/prod/POST/runs',
        }],
      },
      context: {
        error: 'forbidden',
        reason: '이 작업은 admin 권한이 필요합니다.',
      },
    });
  });
});

describe('parseMethodArn', () => {
  it('extracts httpMethod and resourcePath from simple methodArn', () => {
    const arn = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/POST/runs';
    expect(parseMethodArn(arn)).toEqual({
      httpMethod: 'POST',
      resourcePath: '/runs',
    });
  });

  it('replaces runId with {id} placeholder for /runs/{id}/status pattern', () => {
    const arn = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/GET/runs/rid-20260519010000/status';
    expect(parseMethodArn(arn)).toEqual({
      httpMethod: 'GET',
      resourcePath: '/runs/{id}/status',
    });
  });

  it('replaces id with {id} for /runs/{id}/abort pattern', () => {
    const arn = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/POST/runs/rid-20260519010000/abort';
    expect(parseMethodArn(arn)).toEqual({
      httpMethod: 'POST',
      resourcePath: '/runs/{id}/abort',
    });
  });

  it('replaces id with {id} for /runs/{id} (bare get-run)', () => {
    const arn = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/GET/runs/rid-20260519010000';
    expect(parseMethodArn(arn)).toEqual({
      httpMethod: 'GET',
      resourcePath: '/runs/{id}',
    });
  });

  it('replaces id for /reports/{id} and /reports/{id}/pdf', () => {
    const a = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/GET/reports/rid-20260519010000';
    const b = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/GET/reports/rid-20260519010000/pdf';
    expect(parseMethodArn(a).resourcePath).toBe('/reports/{id}');
    expect(parseMethodArn(b).resourcePath).toBe('/reports/{id}/pdf');
  });
});

describe('matchesEndpoint', () => {
  it('allows admin to POST /runs', () => {
    expect(matchesEndpoint('POST', '/runs', ['admin'])).toBe('allow');
  });

  it('forbids viewer from POST /runs', () => {
    expect(matchesEndpoint('POST', '/runs', ['viewer'])).toBe('forbidden');
  });

  it('allows viewer to GET /runs', () => {
    expect(matchesEndpoint('GET', '/runs', ['viewer'])).toBe('allow');
  });

  it('forbids no-group user from GET /runs', () => {
    expect(matchesEndpoint('GET', '/runs', [])).toBe('forbidden');
  });

  it('returns unknown_resource for endpoint not in matrix', () => {
    expect(matchesEndpoint('DELETE', '/runs', ['admin'])).toBe('unknown_resource');
    expect(matchesEndpoint('POST', '/foo/bar', ['admin'])).toBe('unknown_resource');
  });

  it('allows admin to POST /runs/{id}/abort', () => {
    expect(matchesEndpoint('POST', '/runs/{id}/abort', ['admin'])).toBe('allow');
  });

  it('forbids viewer from POST /runs/{id}/abort', () => {
    expect(matchesEndpoint('POST', '/runs/{id}/abort', ['viewer'])).toBe('forbidden');
  });

  it('allows admin or viewer to GET /reports/{id}/pdf', () => {
    expect(matchesEndpoint('GET', '/reports/{id}/pdf', ['admin'])).toBe('allow');
    expect(matchesEndpoint('GET', '/reports/{id}/pdf', ['viewer'])).toBe('allow');
  });

  it('allows GET /loader-info for either group', () => {
    expect(matchesEndpoint('GET', '/loader-info', ['admin'])).toBe('allow');
    expect(matchesEndpoint('GET', '/loader-info', ['viewer'])).toBe('allow');
  });
});

describe('decodeGroups', () => {
  it('returns array as-is when given array', () => {
    expect(decodeGroups(['admin', 'viewer'])).toEqual(['admin', 'viewer']);
  });

  it('returns empty array for undefined / null', () => {
    expect(decodeGroups(undefined)).toEqual([]);
    expect(decodeGroups(null)).toEqual([]);
  });

  it('splits comma-separated string (downstream context decode)', () => {
    expect(decodeGroups('admin,viewer')).toEqual(['admin', 'viewer']);
    expect(decodeGroups('admin')).toEqual(['admin']);
  });

  it('returns empty array for empty string', () => {
    expect(decodeGroups('')).toEqual([]);
  });
});
