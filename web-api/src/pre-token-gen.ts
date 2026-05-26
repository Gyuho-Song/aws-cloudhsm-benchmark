/**
 * Cognito Pre-Token-Generation Lambda Trigger V2.
 *
 * On admin login:    new sessionId (uuid v4) → DDB PutItem (last-write-wins)
 *                    → access token claim `custom:sessionId`.
 * On admin refresh:  preserve existing sessionId (DDB GetItem only) →
 *                    access token claim. Avoids self-logout when same admin
 *                    refreshes a 24h access token.
 * On viewer:         no DDB write, no claim override.
 *
 * Implements `customer-handover-requirements.md` FR-CH-2.
 */

import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { truncateUtf8 } from './lib/auth';

const SESSIONS_TABLE = process.env.ADMIN_SESSIONS_TABLE!;

// module-scope singletons — Lambda warm reuse, fast-fail timeouts.
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

interface PreTokenGenV2Event {
  triggerSource: string;
  userName: string;
  callerContext?: {
    sourceIp?: string;
    userAgent?: string;
  };
  request: {
    groupConfiguration?: {
      groupsToOverride?: string[];
    };
  };
  response: {
    claimsAndScopeOverrideDetails: null | {
      accessTokenGeneration?: {
        claimsToAddOrOverride: Record<string, string>;
      };
    };
  };
}

const REFRESH_TRIGGER = 'TokenGeneration_RefreshTokens';
const SESSION_TTL_SECONDS = 30 * 24 * 3600;

export async function handler(event: PreTokenGenV2Event): Promise<PreTokenGenV2Event> {
  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const isAdmin = groups.includes('admin');

  if (!isAdmin) {
    // viewer or no-group — no claim override, no DDB write
    return event;
  }

  let sessionIdForClaim: string;

  if (event.triggerSource === REFRESH_TRIGGER) {
    // refresh path: preserve sid (avoid self-logout)
    const existing = await ddbDoc.send(new GetCommand({
      TableName: SESSIONS_TABLE,
      Key: { username: event.userName },
    }));
    const sid = existing.Item?.currentSessionId as string | undefined;
    if (!sid) {
      throw new Error(`admin session row missing on refresh for ${event.userName}`);
    }
    sessionIdForClaim = sid;
  } else {
    // first login (HostedAuth / Authentication) — new sid + DDB upsert
    const newSid = randomUUID();
    const nowIso = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

    await ddbDoc.send(new PutCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        username: event.userName,
        currentSessionId: newSid,
        lastLoginAt: nowIso,
        lastIp: event.callerContext?.sourceIp ?? 'unknown',
        userAgent: truncateUtf8(event.callerContext?.userAgent ?? '', 256),
        expiresAt,
      },
    }));

    sessionIdForClaim = newSid;
  }

  event.response.claimsAndScopeOverrideDetails = {
    accessTokenGeneration: {
      claimsToAddOrOverride: {
        'custom:sessionId': sessionIdForClaim,
      },
    },
  };

  return event;
}
