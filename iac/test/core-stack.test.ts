import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CoreStack } from '../lib/core-stack';

function synthCoreStack(ctx?: Record<string, unknown>): Template {
  const app = new cdk.App({ context: ctx });
  const stack = new CoreStack(app, 'CoreStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  return Template.fromStack(stack);
}

describe('CoreStack integration', () => {
  // Behavior 7.1
  test('synth produces all expected resource categories without errors', () => {
    const t = synthCoreStack();
    t.resourceCountIs('AWS::EC2::VPC', 1);
    // CloudHSM cluster + HSMs are managed out-of-band by scripts/cluster-create.sh
    // (AWS::CloudHSMV2::* are not valid CFN types and a Lambda Custom Resource
    // exceeds the 2-hour CFN ceiling for 6 sequential HSM creates).
    t.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
    t.resourceCountIs('AWS::EC2::Instance', 1); // loader only
    t.resourceCountIs('AWS::S3::Bucket', 1);
    t.resourceCountIs('AWS::SecretsManager::Secret', 3);
  });

  // Behavior 7.2 — SSM Parameter Store outputs
  test('publishes core SSM parameters under /hsm-bmt/core/ (cluster-id is written by operator script, not CDK)', () => {
    const t = synthCoreStack();
    const expectedParamNames = [
      '/hsm-bmt/core/vpc-id',
      '/hsm-bmt/core/subnet-ids-csv',
      '/hsm-bmt/core/loader-sg-id',
      '/hsm-bmt/core/loader-role-arn',
      '/hsm-bmt/core/loader-instance-id',
      '/hsm-bmt/core/cluster-sg-id',
      '/hsm-bmt/core/s3-bucket-name',
      '/hsm-bmt/core/co-password-secret-arn',
      '/hsm-bmt/core/cu-password-secret-arn',
      '/hsm-bmt/core/hsm-slots',
      '/hsm-bmt/core/desired-hsm-count',
    ];
    const params = t.findResources('AWS::SSM::Parameter');
    const names = Object.values(params).map((p) => (p as { Properties: { Name: string } }).Properties.Name);
    for (const expected of expectedParamNames) {
      expect(names).toContain(expected);
    }
    // /hsm-bmt/core/cluster-id is NOT published by CDK: cluster-create.sh writes it.
    expect(names).not.toContain('/hsm-bmt/core/cluster-id');
  });

  test('repositoryProvider=github creates SSM handoff parameter and no CodeCommit', () => {
    const t = synthCoreStack({ repositoryProvider: 'github' });
    t.resourceCountIs('AWS::CodeCommit::Repository', 0);
    const params = t.findResources('AWS::SSM::Parameter');
    const names = Object.values(params).map((p) => (p as { Properties: { Name: string } }).Properties.Name);
    expect(names).toContain('/hsm-bmt/core/repo-instructions');
  });
});
