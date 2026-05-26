import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class DynamoDbConstruct extends Construct {
  public readonly runsTable: dynamodb.Table;
  public readonly unitsTable: dynamodb.Table;
  public readonly adminSessionsTable: dynamodb.Table;
  public readonly runsLockTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.runsTable = new dynamodb.Table(this, 'RunsTable', {
      tableName: 'bmt-runs',
      partitionKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      // Streams the new image so the report-trigger lambda can fire when a
      // run flips to status=COMPLETED.
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });
    this.runsTable.addGlobalSecondaryIndex({
      indexName: 'status-startedAt',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startedAt', type: dynamodb.AttributeType.STRING },
    });

    this.unitsTable = new dynamodb.Table(this, 'UnitsTable', {
      tableName: 'bmt-units',
      partitionKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'unitId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
    });
    this.unitsTable.addGlobalSecondaryIndex({
      indexName: 'runId-status',
      partitionKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    // U-CH-1: Cognito admin single-session enforcement (FR-CH-2).
    // PK = cognito:username; TTL via expiresAt (lastLoginAt + 30d).
    // PITR=true to match runsTable / unitsTable consistency.
    this.adminSessionsTable = new dynamodb.Table(this, 'AdminSessionsTable', {
      tableName: 'bmt-admin-sessions',
      partitionKey: { name: 'username', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecovery: true,
    });

    // U-CH-2: Run-level concurrency lock (FR-CH-6.1). Single row at key='global'
    // holds the active runId; ConditionalUpdate(attribute_not_exists OR '')
    // serializes start-run across multi-proc orchestrators. The lock survives
    // restarts so a crashed orchestrator does not leak it forever — an admin
    // can clear it with abort-run on the active runId.
    this.runsLockTable = new dynamodb.Table(this, 'RunsLockTable', {
      tableName: 'bmt-runs-lock',
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
    });
  }
}
