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

  const unitsResp = await ddb().send(new QueryCommand({
    TableName: unitsTable,
    KeyConditionExpression: 'runId = :rid',
    ExpressionAttributeValues: { ':rid': runId },
    Limit: 200,
  }));

  return json(200, { run: runResp.Item, units: unitsResp.Items ?? [] });
}
