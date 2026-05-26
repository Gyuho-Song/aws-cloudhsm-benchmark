/**
 * Shared auth helpers for U-CH-1.
 *
 * Used by both Lambdas (pre-token-gen, custom-authorizer) and downstream
 * Lambdas that decode `context.groups` from authorizer.
 */

/** UTF-8 byte-aware truncation. Korean / multibyte characters preserved
 *  intact (no broken codepoints). */
export function truncateUtf8(s: string | null | undefined, maxBytes: number): string {
  if (!s) return '';
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  // forward truncate — trim until under limit. binary search for performance.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return s.slice(0, lo);
}

/** API Gateway Lambda authorizer Deny IAM policy. error/reason 은
 *  GatewayResponse VTL 이 body 로 변환. */
export function denyPolicy(methodArn: string, errorCode: string, reason: string) {
  return {
    principalId: 'unknown',
    policyDocument: {
      Version: '2012-10-17' as const,
      Statement: [{
        Effect: 'Deny' as const,
        Action: 'execute-api:Invoke' as const,
        Resource: methodArn,
      }],
    },
    context: { error: errorCode, reason },
  };
}

export interface ParsedMethodArn {
  httpMethod: string;
  resourcePath: string;
}

/** Parse API Gateway methodArn → {httpMethod, resourcePath}. Path tokens that
 *  look like a runId (rid-... or uuid) are normalized to `{id}` to match the
 *  endpoint matrix. */
export function parseMethodArn(arn: string): ParsedMethodArn {
  // arn shape: arn:aws:execute-api:<region>:<account>:<apiId>/<stage>/<METHOD>/<path...>
  const tail = arn.split(':').slice(5).join(':');           // <apiId>/<stage>/<METHOD>/<path...>
  const parts = tail.split('/');
  // parts: [<apiId>, <stage>, <METHOD>, ...<pathSegments>]
  const httpMethod = parts[2];
  const segments = parts.slice(3).map(normalizeIdSegment);
  const resourcePath = '/' + segments.join('/');
  return { httpMethod, resourcePath: resourcePath === '/' ? '/' : resourcePath };
}

function normalizeIdSegment(seg: string): string {
  // runId 패턴: rid-<14 digit>
  if (/^rid-\d{14}$/.test(seg)) return '{id}';
  // generic uuid (defensive)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{id}';
  return seg;
}

/** Endpoint × method matrix from FR-CH-1.2.
 *  Value: 'admin' (admin only) | 'either' (admin or viewer) */
const ENDPOINT_MATRIX: Record<string, 'admin' | 'either'> = {
  'POST /runs': 'admin',
  'GET /runs': 'either',
  'GET /runs/{id}': 'either',
  'POST /runs/{id}/abort': 'admin',
  'GET /runs/{id}/status': 'either',
  'GET /reports/{id}': 'either',
  'GET /reports/{id}/pdf': 'either',
  'GET /loader-info': 'either',
  // HOS-Step4/Step6 cluster routes
  'GET /cluster/status': 'either',
  'POST /cluster/provision': 'admin',
  // Phase F (cluster-state-rca-plan) — admin-only emergency unlock
  'POST /cluster/force-unlock': 'admin',
};

export type MatchResult = 'allow' | 'forbidden' | 'unknown_resource';

export function matchesEndpoint(
  httpMethod: string,
  resourcePath: string,
  userGroups: string[],
): MatchResult {
  const key = `${httpMethod} ${resourcePath}`;
  const required = ENDPOINT_MATRIX[key];
  if (!required) return 'unknown_resource';
  const isAdmin = userGroups.includes('admin');
  const isViewer = userGroups.includes('viewer');
  if (required === 'admin') return isAdmin ? 'allow' : 'forbidden';
  // either
  return isAdmin || isViewer ? 'allow' : 'forbidden';
}

/** Korean hint catalog for FR-CH-7.5 — out-of-range field validation. */
const FIELD_HINTS: Record<string, string> = {
  procs: 'procs 는 1 이상 16 이하의 정수입니다.',
  workerCount: 'workerCount 는 16 이상 1024 이하의 정수입니다.',
  procs256: 'procs256 은 1 이상 16 이하의 정수입니다.',
  procs1024: 'procs1024 는 1 이상 16 이하의 정수입니다.',
};

/** Build a 400 response body for out-of-range field violations (FR-CH-7.5). */
export function rangeError(field: string, min: number, max: number, received: unknown) {
  return {
    error: `${field} out of range [${min}, ${max}]`,
    received,
    hint: FIELD_HINTS[field] ?? `${field} 는 ${min} 이상 ${max} 이하의 정수입니다.`,
  };
}

/** Decode `cognito:groups` claim or downstream context.groups string.
 *  Cognito claim is array; API Gateway authorizer context is string-only so
 *  downstream Lambda receives comma-separated string. */
export function decodeGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.filter(s => typeof s === 'string') as string[];
  if (typeof claim === 'string') {
    return claim ? claim.split(',').filter(Boolean) : [];
  }
  return [];
}
