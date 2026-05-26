import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { ddb } from './lib/ddb';
import { json } from './lib/types';

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const runId = event.pathParameters?.id;
  if (!runId) return json(400, { error: 'runId path parameter required' });

  const runsTable = process.env.RUNS_TABLE!;
  const unitsTable = process.env.UNITS_TABLE!;

  const runResp = await ddb().send(new GetCommand({ TableName: runsTable, Key: { runId } }));
  if (!runResp.Item) return json(404, { error: 'run not found', runId });
  const run = runResp.Item;

  const completedResp = await ddb().send(new QueryCommand({
    TableName: unitsTable,
    IndexName: 'runId-status',
    KeyConditionExpression: 'runId = :rid AND #s = :st',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':rid': runId, ':st': 'COMPLETED' },
    Select: 'COUNT',
  }));
  const completed = completedResp.Count ?? 0;

  // Latest unit (any status) — Query without filter, sorted by SK descending
  const latestResp = await ddb().send(new QueryCommand({
    TableName: unitsTable,
    KeyConditionExpression: 'runId = :rid',
    ExpressionAttributeValues: { ':rid': runId },
    ScanIndexForward: false,
    Limit: 1,
  }));
  const currentUnit = latestResp.Items?.[0];

  // Compute ETA from mean completed-unit duration
  let etaUtc: string | null = null;
  if (currentUnit && run.totalUnits && completed < run.totalUnits) {
    const remaining = (run.totalUnits as number) - completed;
    const meanDurMs = currentUnit.startedAt && currentUnit.completedAt
      ? (Date.parse(currentUnit.completedAt) - Date.parse(currentUnit.startedAt))
      : 6.5 * 60 * 1000; // fall back to NFR-3.6 budget
    etaUtc = new Date(Date.now() + remaining * meanDurMs).toISOString();
  }

  // Live p99/error rate would come from AMP; left as fields the UI can fill in later.
  // Returning DDB-derived fields keeps the endpoint self-contained for tests.
  // 2026-05-23: include completedAt so the live page can show "종료 (UTC)"
  // on terminal-state runs instead of an indefinite "계산 중…" ETA.
  return json(200, {
    runId,
    status: run.status,
    completed,
    total: run.totalUnits,
    currentUnit,
    etaUtc,
    completedAt: (run.completedAt as string | undefined) ?? null,
  });
}
