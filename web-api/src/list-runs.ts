import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { ddb } from './lib/ddb';
import { json } from './lib/types';

export async function handler(_event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const tableName = process.env.RUNS_TABLE!;
  const pageLimit = 50;
  // We must paginate the full scan because DDB's Scan returns rows in
  // partition-key hash order — using a simple `Limit: 50` would silently
  // hide recent runs whose partition-hash buckets fall after the first
  // page. Observed 2026-05-22: a RUNNING run was missing from the overview
  // because its hash placed it on page 2. Bench scale stays small (~100
  // rows total), so paginating the whole table is fine.
  const items: Record<string, unknown>[] = [];
  let exclusive: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(new ScanCommand({
      TableName: tableName,
      Limit: pageLimit,
      ExclusiveStartKey: exclusive,
    }));
    if (out.Items) items.push(...out.Items);
    exclusive = out.LastEvaluatedKey;
  } while (exclusive);

  items.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  // Cap returned payload — frontend only renders ~50 rows anyway and
  // shows the rest behind a "show hidden" toggle that filters by date.
  return json(200, { runs: items.slice(0, 100) });
}
