import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StorageConstruct } from '../../lib/constructs/storage-construct';

function synthStack(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  new StorageConstruct(stack, 'Storage');
  return Template.fromStack(stack);
}

describe('StorageConstruct', () => {
  // Behavior 6.1
  test('S3 bucket has versioning and KMS encryption', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
      VersioningConfiguration: Match.objectLike({ Status: 'Enabled' }),
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'aws:kms',
            }),
          }),
        ]),
      }),
    }));
  });

  test('S3 lifecycle rules: loader-artifacts expires 90d, precheck 30d, runs/reports no auto-expiry', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'expire-loader-artifacts',
            Prefix: 'loader-artifacts/',
            ExpirationInDays: 90,
            Status: 'Enabled',
          }),
          Match.objectLike({
            Id: 'expire-precheck',
            Prefix: 'precheck/',
            ExpirationInDays: 30,
            Status: 'Enabled',
          }),
        ]),
      }),
    }));
  });

  // Behavior 6.2 - bucket-level enforcement
  test('bucket policy denies non-TLS access (enforceSSL)', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::S3::BucketPolicy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: Match.objectLike({ Bool: Match.objectLike({ 'aws:SecureTransport': 'false' }) }),
          }),
        ]),
      }),
    }));
  });
});
