/**
 * DynamoDB Streams trigger that fires the Korean report renderer on the loader
 * EC2 whenever a row in `bmt-runs` flips its status to COMPLETED.
 *
 * The renderer itself is a Python package (`report/`) running on the loader
 * (it already has S3 / AMP read access via the instance role). This lambda
 * issues an SSM SendCommand to invoke `/usr/local/bin/render-report.sh <runId>`.
 */
import type { DynamoDBStreamEvent } from 'aws-lambda';
export declare function handler(event: DynamoDBStreamEvent): Promise<void>;
