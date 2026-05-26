/**
 * API Gateway custom REQUEST authorizer Lambda.
 *
 * Validates:
 *  1. JWT (Cognito access token) signature + iss + tokenUse + client_id (aws-jwt-verify)
 *  2. Endpoint × group permission matrix (FR-CH-1.2)
 *  3. Single-admin-session: token's `custom:sessionId` matches DDB
 *     `bmt-admin-sessions[username].currentSessionId`
 *
 * Returns IAM Allow / Deny policy. Deny responses carry `context.error` /
 * `context.reason` which API Gateway GatewayResponse VTL maps to body
 * `{error, reason}` and overrides status (401 for unauthorized /
 * session_invalidated / precondition_failed; 403 for forbidden /
 * unknown_resource).
 */

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  denyPolicy,
  parseMethodArn,
  matchesEndpoint,
  decodeGroups,
} from './lib/auth';

const SESSIONS_TABLE = process.env.ADMIN_SESSIONS_TABLE!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

// module-scope singletons — Lambda warm reuse, lazy hydrate (first verify
// triggers JWKS fetch +200ms cold add — accepted trade-off).
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'access',
  clientId: USER_POOL_CLIENT_ID,
});

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 1000,
      socketTimeout: 2000,
    }),
    maxAttempts: 3,
  }),
  { marshallOptions: { removeUndefinedValues: true } },
);

interface RequestAuthorizerEvent {
  type: 'REQUEST';
  methodArn: string;
  headers?: Record<string, string>;
}

export async function handler(event: RequestAuthorizerEvent) {
  const methodArn = event.methodArn;

  // 1) Extract Bearer token (case-insensitive)
  const authHeader =
    event.headers?.Authorization ?? event.headers?.authorization ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return denyPolicy(methodArn, 'unauthorized', '인증 헤더가 필요합니다.');
  }
  const token = authHeader.slice('Bearer '.length);

  // 2) Verify JWT
  let payload: Record<string, unknown>;
  try {
    payload = await verifier.verify(token);
  } catch {
    return denyPolicy(methodArn, 'unauthorized', '토큰 검증 실패.');
  }

  // Cognito access tokens carry `username`; id tokens carry `cognito:username`.
  // We require access tokens (tokenUse: 'access' above) so prefer `username`,
  // fall back to `cognito:username` defensively.
  const username = (payload['username'] as string | undefined)
    ?? (payload['cognito:username'] as string | undefined);
  const sub = payload.sub as string | undefined;
  const groups = decodeGroups(payload['cognito:groups']);
  const tokenSessionId = payload['custom:sessionId'] as string | undefined;

  if (!username || !sub) {
    return denyPolicy(methodArn, 'unauthorized', '사용자 정보 누락.');
  }

  // 3) Endpoint × group matrix
  const { httpMethod, resourcePath } = parseMethodArn(methodArn);
  const match = matchesEndpoint(httpMethod, resourcePath, groups);

  if (match === 'unknown_resource') {
    return denyPolicy(methodArn, 'unknown_resource', '알 수 없는 endpoint 입니다.');
  }
  if (match === 'forbidden') {
    return denyPolicy(methodArn, 'forbidden', '이 작업은 admin 권한이 필요합니다.');
  }

  // 4) Single-admin-session check (admin only; viewer skipped)
  if (groups.includes('admin')) {
    const row = await ddbDoc.send(new GetCommand({
      TableName: SESSIONS_TABLE,
      Key: { username },
    }));
    const ddbSid = row.Item?.currentSessionId as string | undefined;
    if (!ddbSid) {
      return denyPolicy(
        methodArn,
        'precondition_failed',
        '세션 정보가 없습니다. 다시 로그인하세요.',
      );
    }
    if (ddbSid !== tokenSessionId) {
      return denyPolicy(
        methodArn,
        'session_invalidated',
        '다른 위치에서 로그인되어 자동 로그아웃됩니다.',
      );
    }
  }

  // 5) Allow
  return {
    principalId: username,
    policyDocument: {
      Version: '2012-10-17' as const,
      Statement: [{
        Effect: 'Allow' as const,
        Action: 'execute-api:Invoke' as const,
        Resource: methodArn,
      }],
    },
    context: {
      username,
      groups: groups.join(','),
      sub,
    },
  };
}
