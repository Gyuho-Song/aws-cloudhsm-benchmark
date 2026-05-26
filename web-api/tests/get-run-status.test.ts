import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.RUNS_TABLE = 'bmt-runs';
  process.env.UNITS_TABLE = 'bmt-units';
});

function loadHandler() {
  return require('../src/get-run-status').handler;
}

test('returns 404 when run does not exist', async () => {
  ddbMock.on(GetCommand).resolves({});
  const handler = loadHandler();
  const result = await handler({ pathParameters: { id: 'missing' } } as any);
  expect(result.statusCode).toBe(404);
});

test('returns completed/total + ETA for in-progress run', async () => {
  ddbMock.on(GetCommand).resolves({
    Item: { runId: 'r1', status: 'RUNNING', totalUnits: 140 },
  });
  // Two QueryCommands: COUNT for completed, then latest unit
  ddbMock.on(QueryCommand)
    .resolvesOnce({ Count: 47 } as any)
    .resolvesOnce({
      Items: [{
        runId: 'r1',
        unitId: 'v3-aes_256-ecb-1024-c6-VA',
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 30_000).toISOString(),
      }],
    });
  const handler = loadHandler();
  const result = await handler({ pathParameters: { id: 'r1' } } as any);
  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.completed).toBe(47);
  expect(body.total).toBe(140);
  expect(body.etaUtc).toMatch(/T.*Z$/);
});
