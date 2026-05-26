import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

// aws-jwt-verify mock — must run BEFORE handler import
const verifyMock = jest.fn();
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: verifyMock,
    }),
  },
}));

const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.ADMIN_SESSIONS_TABLE = 'bmt-admin-sessions';
process.env.USER_POOL_ID = 'ap-northeast-2_test';
process.env.USER_POOL_CLIENT_ID = 'test-client-id';

import { handler } from '../src/custom-authorizer';

const ARN_POST_RUNS = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/POST/runs';
const ARN_GET_RUNS = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/GET/runs';
const ARN_DELETE_RUNS = 'arn:aws:execute-api:ap-northeast-2:123:apiid/prod/DELETE/runs';

function event(authHeader: string | undefined, methodArn: string): any {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  return {
    type: 'REQUEST',
    methodArn,
    resource: '/runs',
    path: '/runs',
    httpMethod: 'POST',
    headers,
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
  };
}

beforeEach(() => {
  ddbMock.reset();
  verifyMock.mockReset();
});

describe('custom-authorizer handler', () => {
  it('Behavior 3.1: admin happy path with matching sessionId → Allow', async () => {
    verifyMock.mockResolvedValue({
      'cognito:username': 'alice@example.com',
      'cognito:groups': ['admin'],
      'custom:sessionId': 'sid-abc',
      sub: 'alice-sub',
    });
    ddbMock.on(GetCommand).resolves({
      Item: { username: 'alice@example.com', currentSessionId: 'sid-abc' },
    });

    const result = await handler(event('Bearer valid.token.here', ARN_POST_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    expect((result.context as any).username).toBe('alice@example.com');
    expect((result.context as any).groups).toBe('admin');
  });

  it('Behavior 3.2: viewer GET /runs → Allow (sessionId check skipped)', async () => {
    verifyMock.mockResolvedValue({
      'cognito:username': 'bob@example.com',
      'cognito:groups': ['viewer'],
      sub: 'bob-sub',
    });
    // ddbMock: no GetCommand stub — handler should not call DDB

    const result = await handler(event('Bearer t', ARN_GET_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('Behavior 3.3: viewer POST /runs → Deny forbidden', async () => {
    verifyMock.mockResolvedValue({
      'cognito:username': 'bob@example.com',
      'cognito:groups': ['viewer'],
      sub: 'bob-sub',
    });

    const result = await handler(event('Bearer t', ARN_POST_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect((result.context as any).error).toBe('forbidden');
    expect((result.context as any).reason).toMatch(/admin/);
  });

  it('Behavior 3.4: admin sessionId mismatch → Deny session_invalidated', async () => {
    verifyMock.mockResolvedValue({
      'cognito:username': 'alice@example.com',
      'cognito:groups': ['admin'],
      'custom:sessionId': 'sid-stale',
      sub: 'alice-sub',
    });
    ddbMock.on(GetCommand).resolves({
      Item: { username: 'alice@example.com', currentSessionId: 'sid-fresh' },
    });

    const result = await handler(event('Bearer t', ARN_POST_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect((result.context as any).error).toBe('session_invalidated');
    expect((result.context as any).reason).toMatch(/다른 위치/);
  });

  it('Behavior 3.5: admin DDB row missing (PreTokenGen failure) → Deny precondition_failed', async () => {
    verifyMock.mockResolvedValue({
      'cognito:username': 'alice@example.com',
      'cognito:groups': ['admin'],
      'custom:sessionId': 'sid-abc',
      sub: 'alice-sub',
    });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await handler(event('Bearer t', ARN_POST_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect((result.context as any).error).toBe('precondition_failed');
  });

  it('Behavior 3.6: JWT verify failure → Deny unauthorized', async () => {
    verifyMock.mockRejectedValue(new Error('signature verify failed'));

    const result = await handler(event('Bearer expired.token', ARN_POST_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect((result.context as any).error).toBe('unauthorized');
  });

  it('Behavior 3.7: Authorization header missing → Deny unauthorized', async () => {
    const result = await handler(event(undefined, ARN_POST_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect((result.context as any).error).toBe('unauthorized');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('Behavior 3.8: Bearer prefix missing → Deny unauthorized', async () => {
    const result = await handler(event('eyJ...', ARN_POST_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect((result.context as any).error).toBe('unauthorized');
  });

  it('Behavior 3.9: unknown endpoint (DELETE /runs) → Deny unknown_resource', async () => {
    verifyMock.mockResolvedValue({
      'cognito:username': 'alice@example.com',
      'cognito:groups': ['admin'],
      'custom:sessionId': 'sid-abc',
      sub: 'alice-sub',
    });

    const result = await handler(event('Bearer t', ARN_DELETE_RUNS));

    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect((result.context as any).error).toBe('unknown_resource');
  });

  it('Behavior 3.10: case-insensitive Authorization header (lowercase)', async () => {
    verifyMock.mockResolvedValue({
      'cognito:username': 'bob@example.com',
      'cognito:groups': ['viewer'],
      sub: 'bob-sub',
    });

    const e = event(undefined, ARN_GET_RUNS);
    e.headers.authorization = 'Bearer t';   // lowercase

    const result = await handler(e);

    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
  });
});
