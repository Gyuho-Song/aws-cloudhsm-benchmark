import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  process.env.RUNS_TABLE = 'bmt-runs';
  process.env.RUNS_LOCK_TABLE = 'bmt-runs-lock';
  process.env.LOADER_INSTANCE_ID = 'i-test';
  process.env.RESULTS_BUCKET = 'hsm-bmt-results-test';
  // U-CH-2: lock acquire 도 mock
  ddbMock.on(UpdateCommand).resolves({});
});

function loadHandler() {
  // require after env setup so module-level clients pick up env values
  return require('../src/start-run').handler;
}

const validInput = {
  matrixSubset: {
    families: ['V3'],
    algorithms: ['AES_256'],
    modes: [],
    payloadBytes: [1024],
    clusterSizes: [6],
    variants: ['A', 'B'],
    runner: 'c-native-multiproc',
    procs: 6,
  },
  expectedLoaderVersionId: 'vAbc',
  expectedLoaderSha256: 'sha-abc',
};

test('POST /runs creates a run row and triggers SSM SendCommand', async () => {
  ddbMock.on(PutCommand).resolves({});
  ssmMock.on(SendCommandCommand).resolves({});

  const handler = loadHandler();
  const result = await handler({
    body: JSON.stringify(validInput),
    requestContext: { authorizer: { jwt: { claims: { sub: 'cog-sub-1' } } } },
  } as any);

  expect(result.statusCode).toBe(202);
  const body = JSON.parse(result.body);
  expect(body.runId).toMatch(/^rid-\d{14}$/);
  expect(body.status).toBe('PENDING');
  expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(1);
});

test('POST /runs rejects empty matrix', async () => {
  const handler = loadHandler();
  const result = await handler({
    body: JSON.stringify({ ...validInput, matrixSubset: { ...validInput.matrixSubset, families: [] } }),
    requestContext: { authorizer: { jwt: { claims: { sub: 'cog-sub-1' } } } },
  } as any);
  expect(result.statusCode).toBe(400);
});

test('POST /runs rejects missing loader version id', async () => {
  const handler = loadHandler();
  const result = await handler({
    body: JSON.stringify({ ...validInput, expectedLoaderVersionId: '' }),
    requestContext: { authorizer: { jwt: { claims: { sub: 'cog-sub-1' } } } },
  } as any);
  expect(result.statusCode).toBe(400);
});

test('POST /runs persists expected loader sha + version id (NFR-3.5)', async () => {
  ddbMock.on(PutCommand).resolves({});
  ssmMock.on(SendCommandCommand).resolves({});
  const handler = loadHandler();
  await handler({
    body: JSON.stringify(validInput),
    requestContext: { authorizer: { jwt: { claims: { sub: 'cog-sub-1' } } } },
  } as any);
  const calls = ddbMock.commandCalls(PutCommand);
  const item = calls[0].args[0].input.Item as Record<string, unknown>;
  expect(item.expectedLoaderVersionId).toBe('vAbc');
  expect(item.expectedLoaderSha256).toBe('sha-abc');
});

test('POST /runs emits HSM_BMT_PROCS_BY_CLUSTER when matrixSubset provides procsByCluster', async () => {
  ddbMock.on(PutCommand).resolves({});
  ssmMock.on(SendCommandCommand).resolves({});
  const handler = loadHandler();
  await handler({
    body: JSON.stringify({
      matrixSubset: {
        families: ['PER_CALL_RAW'],
        algorithms: ['AES_128'],
        modes: ['ECB'],
        payloadBytes: [1024],
        clusterSizes: [6, 5, 4, 3, 2],
        variants: [],
        runner: 'c-native-multiproc',
        procs: 8,
        autoScale: true,
        procsByCluster: { 6: 12, 5: 12, 4: 10, 3: 8, 2: 6 },
      },
      expectedLoaderVersionId: 'vAbc',
      expectedLoaderSha256: 'sha-abc',
    }),
    requestContext: { authorizer: { jwt: { claims: { sub: 'cog-sub-1' } } } },
  } as any);
  const ssmCall = ssmMock.commandCalls(SendCommandCommand)[0];
  const cmds = ssmCall.args[0].input.Parameters?.commands as string[];
  const envWrite = cmds.find(c => c.includes('HSM_BMT_PROCS_BY_CLUSTER='));
  expect(envWrite).toBeDefined();
  // The env value is one entry per size — ordering is whatever Object.entries
  // produces (insertion order; numeric string keys go first ascending).
  expect(envWrite).toContain('6:12');
  expect(envWrite).toContain('5:12');
  expect(envWrite).toContain('4:10');
  expect(envWrite).toContain('3:8');
  expect(envWrite).toContain('2:6');
});
