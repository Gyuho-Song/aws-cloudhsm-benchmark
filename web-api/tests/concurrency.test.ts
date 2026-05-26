import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, SendCommandCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

process.env.RUNS_TABLE = 'bmt-runs';
process.env.RUNS_LOCK_TABLE = 'bmt-runs-lock';
process.env.LOADER_INSTANCE_ID = 'i-test';
process.env.RESULTS_BUCKET = 'hsm-bmt-test';
process.env.ABORT_SSM_PREFIX = '/hsm-bmt/runs/';

import { handler as startRunHandler } from '../src/start-run';
import { handler as abortRunHandler } from '../src/abort-run';

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
});

function startRunEvent(overrides: Partial<any> = {}): any {
  const body = JSON.stringify({
    matrixSubset: {
      families: ['PER_CALL_RAW'],
      algorithms: ['AES_128'],
      modes: ['ECB'],
      payloadBytes: [256],
      clusterSizes: [6],
      variants: [],
      runner: 'java-multiproc',
      procs: 8,
      autoScale: false,
      ...((overrides.matrixOverride as object) ?? {}),
    },
    expectedLoaderVersionId: 'v1',
    expectedLoaderSha256: 'sha1',
    ...overrides,
  });
  return {
    body,
    requestContext: { authorizer: { jwt: { claims: { sub: 'admin-sub-1' } } } },
  };
}

describe('start-run with concurrency lock', () => {
  it('Behavior 2.1: lock acquired + Run row created → 202', async () => {
    ddbMock.on(UpdateCommand).resolves({});       // lock acquire OK
    ddbMock.on(PutCommand).resolves({});          // bmt-runs PutItem OK
    ssmMock.on(SendCommandCommand).resolves({});

    const result: any = await startRunHandler(startRunEvent() as any);

    expect(result.statusCode).toBe(202);
    const body = JSON.parse(result.body);
    expect(body.runId).toMatch(/^rid-\d{14}$/);
    expect(body.status).toBe('PENDING');

    // Lock 이 먼저 acquire 되었는지 검증 — UpdateCommand 가 PutCommand 보다 앞서 호출
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(updateCalls).toHaveLength(1);
    expect(putCalls).toHaveLength(1);
    // lock UpdateExpression contains activeRunId
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.TableName).toBe('bmt-runs-lock');
    expect(updateInput.UpdateExpression).toContain('activeRunId');
    expect(updateInput.ConditionExpression).toContain('attribute_not_exists(activeRunId)');
  });

  it('Behavior 2.2: lock conflict → 409 with activeRunId/activeRunStatus', async () => {
    const conflictErr: any = new Error('lock held');
    conflictErr.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(conflictErr);
    ddbMock.on(GetCommand, { TableName: 'bmt-runs-lock' }).resolves({
      Item: { key: 'global', activeRunId: 'rid-20260519010000' },
    });
    ddbMock.on(GetCommand, { TableName: 'bmt-runs' }).resolves({
      Item: { runId: 'rid-20260519010000', status: 'RUNNING' },
    });

    const result: any = await startRunHandler(startRunEvent() as any);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body);
    expect(body.error).toMatch(/another run is already in progress/);
    expect(body.activeRunId).toBe('rid-20260519010000');
    expect(body.activeRunStatus).toBe('RUNNING');
  });

  it('Behavior 2.3: SSM SendCommand failure releases lock + cleans up Run row', async () => {
    ddbMock.on(UpdateCommand).resolves({});       // lock acquire + later release 둘 다 OK
    ddbMock.on(PutCommand).resolves({});
    ssmMock.on(SendCommandCommand).rejects(new Error('ssm down'));

    const result: any = await startRunHandler(startRunEvent() as any);

    expect(result.statusCode).toBe(500);

    // Lock release + Run row FAILED both called
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(3);   // initial acquire + release + row-FAILED
    const tableNames = updateCalls.map(c => c.args[0].input.TableName);
    expect(tableNames).toContain('bmt-runs-lock');
    expect(tableNames).toContain('bmt-runs');
  });

  it('Behavior 2.4: procs out-of-range returns 400 with Korean hint', async () => {
    const result: any = await startRunHandler(startRunEvent({
      matrixOverride: { procs: 99 },
    }) as any);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error).toMatch(/procs/);
    expect(body.received).toBe(99);
    expect(body.hint).toMatch(/procs.*1.*16.*정수/);
  });

  it('Behavior 2.5: workerCount out-of-range returns 400 with Korean hint', async () => {
    const result: any = await startRunHandler(startRunEvent({
      workerCount: 9999,
    }) as any);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error).toMatch(/workerCount/);
    expect(body.hint).toMatch(/workerCount.*16.*1024.*정수/);
  });

  it('Behavior 2.6: family×runner gate still rejects V3+java-multiproc (regression)', async () => {
    const result: any = await startRunHandler(startRunEvent({
      matrixOverride: {
        families: ['V3'],
        runner: 'java-multiproc',
        variants: ['A'],
        modes: [],
      },
    }) as any);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error).toMatch(/V3 family requires runner=c-native-multiproc/);
  });

  it('Behavior 2.7: matrixSubset missing returns 400 (regression)', async () => {
    const event: any = {
      body: JSON.stringify({
        expectedLoaderVersionId: 'v1',
        expectedLoaderSha256: 'sha1',
      }),
      requestContext: { authorizer: { jwt: { claims: { sub: 'admin-sub' } } } },
    };
    const result: any = await startRunHandler(event);
    expect(result.statusCode).toBe(400);
  });
});

describe('abort-run with lock release', () => {
  it('Behavior 2.8: abort releases lock for matching runId + marks DDB ABORTED', async () => {
    ddbMock.on(UpdateCommand).resolves({});       // both bmt-runs and bmt-runs-lock UpdateCommand
    ssmMock.on(PutParameterCommand).resolves({});

    const event: any = {
      pathParameters: { id: 'rid-20260519010000' },
      requestContext: { authorizer: { jwt: { claims: { sub: 'admin-sub' } } } },
    };
    const result: any = await abortRunHandler(event);

    expect(result.statusCode).toBe(200);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    // 2 calls: bmt-runs status=ABORTED + bmt-runs-lock release
    expect(updateCalls.length).toBe(2);
    const tableNames = updateCalls.map(c => c.args[0].input.TableName);
    expect(tableNames).toContain('bmt-runs');
    expect(tableNames).toContain('bmt-runs-lock');
  });

  it('Behavior 2.9: abort lock release silently OK if lock not held by this runId', async () => {
    ddbMock.on(UpdateCommand, { TableName: 'bmt-runs' }).resolves({});
    const conflict: any = new Error('not lock owner');
    conflict.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand, { TableName: 'bmt-runs-lock' }).rejects(conflict);
    ssmMock.on(PutParameterCommand).resolves({});

    const event: any = {
      pathParameters: { id: 'rid-20260519010000' },
      requestContext: { authorizer: { jwt: { claims: { sub: 'admin-sub' } } } },
    };

    // abort 는 200 — lock 이 다른 runId 잡고있어도 bmt-runs row 만 ABORTED 처리
    const result: any = await abortRunHandler(event);
    expect(result.statusCode).toBe(200);
  });
});
