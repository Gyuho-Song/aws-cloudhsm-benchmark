/**
 * DynamoDB Streams trigger that fires the Korean report renderer on the loader
 * EC2 whenever a row in `bmt-runs` flips its status to COMPLETED.
 *
 * The renderer itself is a Python package (`report/`) running on the loader
 * (it already has S3 / AMP read access via the instance role). This lambda
 * issues an SSM SendCommand to invoke `/usr/local/bin/render-report.sh <runId>`.
 */

import type { DynamoDBStreamEvent } from 'aws-lambda';
import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const LOADER_INSTANCE_ID = process.env.LOADER_INSTANCE_ID!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const rec of event.Records) {
    if (rec.eventName !== 'MODIFY' && rec.eventName !== 'INSERT') continue;
    const img = rec.dynamodb?.NewImage;
    if (!img) continue;
    const status = img.status?.S;
    const runId = img.runId?.S;
    if (status !== 'COMPLETED' || !runId) continue;

    console.log(`render report for ${runId}`);
    await ssm.send(new SendCommandCommand({
      InstanceIds: [LOADER_INSTANCE_ID],
      DocumentName: 'AWS-RunShellScript',
      Parameters: {
        commands: [
          `RUN_ID=${runId} S3_BUCKET=${RESULTS_BUCKET} /usr/local/bin/render-report.sh`,
        ],
      },
      Comment: `Render Korean report for ${runId}`,
    }));
  }
}
