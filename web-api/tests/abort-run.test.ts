import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  process.env.RUNS_TABLE = 'bmt-runs';
  process.env.RUNS_LOCK_TABLE = 'bmt-runs-lock';
  process.env.ABORT_SSM_PREFIX = '/hsm-bmt/runs/';
});

function loadHandler() {
  return require('../src/abort-run').handler;
}

test('POST /runs/{id}/abort writes SSM signal and updates status=ABORTED', async () => {
  ssmMock.on(PutParameterCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  const handler = loadHandler();
  const result = await handler({ pathParameters: { id: 'rid-123' } } as any);
  expect(result.statusCode).toBe(200);

  const ssmCalls = ssmMock.commandCalls(PutParameterCommand);
  expect(ssmCalls).toHaveLength(1);
  expect(ssmCalls[0].args[0].input.Name).toBe('/hsm-bmt/runs/rid-123/abort');
  expect(ssmCalls[0].args[0].input.Value).toBe('true');

  const ddbCalls = ddbMock.commandCalls(UpdateCommand);
  // U-CH-2: 2 calls — bmt-runs status=ABORTED + bmt-runs-lock release
  expect(ddbCalls).toHaveLength(2);
  const runsCall = ddbCalls.find(c => c.args[0].input.TableName === 'bmt-runs');
  expect(runsCall?.args[0].input.Key).toEqual({ runId: 'rid-123' });
  const lockCall = ddbCalls.find(c => c.args[0].input.TableName === 'bmt-runs-lock');
  expect(lockCall).toBeDefined();
});

test('POST /runs/{id}/abort returns 400 when id missing', async () => {
  const handler = loadHandler();
  const result = await handler({} as any);
  expect(result.statusCode).toBe(400);
});
