import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// Mock DDB before importing handler (handler module-scope inits client)
const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.ADMIN_SESSIONS_TABLE = 'bmt-admin-sessions';

import { handler } from '../src/pre-token-gen';

beforeEach(() => {
  ddbMock.reset();
});

function adminEvent(triggerSource: string, opts: { username?: string; ip?: string; userAgent?: string } = {}): any {
  return {
    version: '2',
    triggerSource,
    region: 'ap-northeast-2',
    userPoolId: 'ap-northeast-2_test',
    userName: opts.username ?? 'alice@example.com',
    callerContext: {
      sourceIp: opts.ip ?? '203.0.113.1',
      userAgent: opts.userAgent ?? 'Mozilla/5.0',
      awsSdkVersion: '0',
      clientId: 'test',
    },
    request: {
      userAttributes: {},
      groupConfiguration: {
        groupsToOverride: ['admin'],
        iamRolesToOverride: [],
        preferredRole: '',
      },
    },
    response: {
      claimsAndScopeOverrideDetails: null,
    },
  };
}

function viewerEvent(triggerSource: string): any {
  const e = adminEvent(triggerSource);
  e.request.groupConfiguration.groupsToOverride = ['viewer'];
  return e;
}

describe('pre-token-gen handler', () => {
  it('Behavior 2.1: admin first login (HostedAuth) → DDB Put + claim with new uuid', async () => {
    ddbMock.on(PutCommand).resolves({});
    const event = adminEvent('TokenGeneration_HostedAuth');

    const result = await handler(event);

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item!;
    expect(item.username).toBe('alice@example.com');
    expect(typeof item.currentSessionId).toBe('string');
    expect(item.currentSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(item.lastIp).toBe('203.0.113.1');
    expect(item.userAgent).toBe('Mozilla/5.0');
    expect(typeof item.expiresAt).toBe('number');

    const claim = result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration?.claimsToAddOrOverride['custom:sessionId'];
    expect(claim).toBe(item.currentSessionId);
  });

  it('Behavior 2.2: viewer login → no DDB Put, no claim override', async () => {
    const event = viewerEvent('TokenGeneration_HostedAuth');

    const result = await handler(event);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(result.response.claimsAndScopeOverrideDetails).toBeNull();
  });

  it('Behavior 2.3: refresh token (admin) → DDB Get only, sid preserved in claim', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        username: 'alice@example.com',
        currentSessionId: 'preserved-sid-abc',
        lastLoginAt: '2026-05-19T00:00:00.000Z',
        expiresAt: 9999999999,
      },
    });
    const event = adminEvent('TokenGeneration_RefreshTokens');

    const result = await handler(event);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);

    const claim = result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration?.claimsToAddOrOverride['custom:sessionId'];
    expect(claim).toBe('preserved-sid-abc');
  });

  it('Behavior 2.4: refresh but DDB row missing → throw', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const event = adminEvent('TokenGeneration_RefreshTokens');

    await expect(handler(event)).rejects.toThrow(/admin session row missing/i);
  });

  it('Behavior 2.5: DDB throttle propagates (handler does not swallow — SDK middleware retries upstream)', async () => {
    // Note: aws-sdk-client-mock bypasses SDK retry middleware. So we test the
    // "handler does NOT catch/suppress throttle" property instead: throttle
    // bubbles up. SDK-level retry (maxAttempts=3) is verified by reading the
    // DynamoDBClient construction in src/pre-token-gen.ts (maxAttempts: 3).
    const err: any = new Error('throttled');
    err.name = 'ProvisionedThroughputExceededException';
    err.$metadata = { httpStatusCode: 400 };
    err.$retryable = { throttling: true };
    ddbMock.on(PutCommand).rejects(err);

    const event = adminEvent('TokenGeneration_HostedAuth');
    await expect(handler(event)).rejects.toThrow(/throttled/);
  });

  it('Behavior 2.6: Korean userAgent truncated to ≤256 bytes', async () => {
    ddbMock.on(PutCommand).resolves({});
    const koreanUA = '한국어유저에이전트'.repeat(40);   // 9 chars × 40 × 3 byte ≈ 1080 byte
    const event = adminEvent('TokenGeneration_HostedAuth', { userAgent: koreanUA });

    await handler(event);

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(Buffer.byteLength(item.userAgent as string, 'utf8')).toBeLessThanOrEqual(256);
  });
});
