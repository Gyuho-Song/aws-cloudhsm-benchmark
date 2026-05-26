import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './lib/ddb';

// 2026-05-24 multi-cluster scale-out: per-region S3 client. The result bucket
// is region-scoped (parquet + report HTML written by the loader to its own
// region's bucket). DDB row's `region` field selects which bucket + which
// S3 client to fetch with.
const s3Clients: Map<string, S3Client> = new Map();
function s3For(region: string): S3Client {
  let c = s3Clients.get(region);
  if (!c) { c = new S3Client({ region }); s3Clients.set(region, c); }
  return c;
}

interface RegionMap { [region: string]: string }
function parseRegionMap(csv: string | undefined, fallbackRegion: string, fallbackValue: string): RegionMap {
  const out: RegionMap = { [fallbackRegion]: fallbackValue };
  if (!csv) return out;
  for (const entry of csv.split(',')) {
    const [r, v] = entry.split(':').map((s) => s.trim());
    if (r && v) out[r] = v;
  }
  return out;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const runId = event.pathParameters?.id;
  if (!runId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'runId required' }) };

  const homeRegion = process.env.AWS_REGION ?? 'ap-northeast-2';
  const bucketByRegion = parseRegionMap(
    process.env.RESULTS_BUCKET_BY_REGION,
    homeRegion,
    process.env.RESULTS_BUCKET!,
  );

  // Look up run.region (default = home region for legacy rows)
  const runsTable = process.env.RUNS_TABLE!;
  let region = homeRegion;
  try {
    const got = await ddb().send(new GetCommand({ TableName: runsTable, Key: { runId } }));
    region = (got.Item?.region as string | undefined) ?? homeRegion;
  } catch {
    // best-effort
  }
  const bucket = bucketByRegion[region] ?? bucketByRegion[homeRegion];
  const s3 = s3For(region);

  // render-report.sh uploads the rendered HTML at reports/<runId>/index.html.
  const key = `reports/${runId}/index.html`;

  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e: any) {
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'NOT_READY', message: '테스트가 완료된 후 보고서가 제공됩니다.' }),
      };
    }
    throw e;
  }

  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }), { expiresIn: 300 });

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'READY', url }),
  };
}
