import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface StorageConstructProps {
  readonly bucketName?: string;
}

export class StorageConstruct extends Construct {
  public readonly resultsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageConstructProps = {}) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const bucketName = props.bucketName ?? `hsm-bmt-results-${stack.account}-${stack.region}`;

    this.resultsBucket = new s3.Bucket(this, 'ResultsBucket', {
      bucketName,
      versioned: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'expire-loader-artifacts',
          prefix: 'loader-artifacts/',
          expiration: cdk.Duration.days(90),
          enabled: true,
        },
        {
          id: 'expire-precheck',
          prefix: 'precheck/',
          expiration: cdk.Duration.days(30),
          enabled: true,
        },
        // No expiry for runs/* and reports/* - protect Phase 2 data per design §3.6
      ],
    });

    // No bucket-policy SSE deny: bucket-level default encryption (KMS_MANAGED
    // above) already encrypts every object, and `enforceSSL: true` blocks
    // unencrypted transport. An additional Deny on header presence/value just
    // breaks tools that don't bother setting the header (CDK BucketDeployment's
    // `aws s3 sync`, the AWS console, etc.) without adding real protection.
  }
}
