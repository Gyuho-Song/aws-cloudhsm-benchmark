/**
 * U-CH-2 Run-level concurrency lock.
 *
 * DDB row `bmt-runs-lock` (PK key='global') with attribute `activeRunId`.
 * Acquired via ConditionalUpdate (attribute_not_exists OR ''); released by
 * setting back to ''. TTL on `expiresAt` (24h) reclaims stuck locks if
 * orchestrate.sh dies without releasing.
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb';

const LOCK_TTL_SECONDS = 24 * 3600;
const LOCK_KEY = 'global';

export class LockHeldByOther extends Error {
  constructor(public readonly activeRunId?: string) {
    super('Run lock already held');
    this.name = 'LockHeldByOther';
  }
}

/** Try to acquire the global Run lock for `runId`. Throws LockHeldByOther on conflict. */
export async function acquireRunLock(
  table: string,
  runId: string,
  acquiredBy: string,
): Promise<void> {
  const now = new Date();
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { key: LOCK_KEY },
      UpdateExpression: 'SET activeRunId = :rid, acquiredAt = :now, acquiredBy = :sub, expiresAt = :exp',
      ConditionExpression: 'attribute_not_exists(activeRunId) OR activeRunId = :empty',
      ExpressionAttributeValues: {
        ':rid': runId,
        ':now': now.toISOString(),
        ':sub': acquiredBy,
        ':exp': Math.floor(now.getTime() / 1000) + LOCK_TTL_SECONDS,
        ':empty': '',
      },
    }));
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      // Read who holds the lock
      const lock = await ddb().send(new GetCommand({
        TableName: table,
        Key: { key: LOCK_KEY },
      }));
      throw new LockHeldByOther(lock.Item?.activeRunId as string | undefined);
    }
    throw err;
  }
}

/** Release the lock. If `expectedRunId` is supplied, only release when the
 *  current activeRunId matches (CondCheck). Silent no-op on mismatch. */
export async function releaseRunLock(
  table: string,
  expectedRunId?: string,
): Promise<void> {
  try {
    if (expectedRunId) {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { key: LOCK_KEY },
        UpdateExpression: 'SET activeRunId = :empty',
        ConditionExpression: 'activeRunId = :rid',
        ExpressionAttributeValues: { ':empty': '', ':rid': expectedRunId },
      }));
    } else {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { key: LOCK_KEY },
        UpdateExpression: 'SET activeRunId = :empty',
        ExpressionAttributeValues: { ':empty': '' },
      }));
    }
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      // Lock held by other / not held — silent no-op
      return;
    }
    throw err;
  }
}

/** Read current activeRunId (may be empty). For 409 conflict response body. */
export async function getActiveRunId(table: string): Promise<string | undefined> {
  const lock = await ddb().send(new GetCommand({
    TableName: table,
    Key: { key: LOCK_KEY },
  }));
  return lock.Item?.activeRunId as string | undefined;
}
