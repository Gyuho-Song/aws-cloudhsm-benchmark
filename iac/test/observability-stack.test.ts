import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ObservabilityStack } from '../lib/observability-stack';

function synth(): Template {
  const app = new cdk.App();
  const stack = new ObservabilityStack(app, 'ObservabilityStack', {
    env: { account: '111111111111', region: 'ap-northeast-2' },
    envSuffix: 'test',
    expectedHsms: 6,
  });
  return Template.fromStack(stack);
}

describe('ObservabilityStack', () => {
  test('synth produces all expected resource categories', () => {
    const t = synth();
    t.resourceCountIs('AWS::APS::Workspace', 1);
    t.resourceCountIs('AWS::APS::RuleGroupsNamespace', 1);
    // AlertManagerDefinition is suppressed in ap-northeast-2 (CFN type not yet
    // available there); operator applies via `aws amp put-alert-manager-definition`.
    t.resourceCountIs('AWS::APS::AlertManagerDefinition', 0);
    t.resourceCountIs('AWS::Grafana::Workspace', 1);
    t.resourceCountIs('AWS::SNS::Topic', 1);
    // BucketDeployment + DashboardConstruct Custom Resource = >= 1 Custom Resources
    const customResources = t.findResources('AWS::CloudFormation::CustomResource');
    expect(Object.keys(customResources).length).toBeGreaterThanOrEqual(1);
  });

  test('AlertManagerDefinition emitted in non-Seoul regions', () => {
    const app = new cdk.App();
    const stack = new ObservabilityStack(app, 'O', {
      env: { account: '111111111111', region: 'us-east-1' },
      envSuffix: 'test',
      expectedHsms: 6,
    });
    Template.fromStack(stack).resourceCountIs('AWS::APS::AlertManagerDefinition', 1);
  });

  test('publishes 7 SSM parameters under /hsm-bmt/observability/', () => {
    const t = synth();
    const expected = [
      '/hsm-bmt/observability/amp-workspace-id',
      '/hsm-bmt/observability/amp-prometheus-endpoint',
      '/hsm-bmt/observability/amp-remote-write-url',
      '/hsm-bmt/observability/amg-workspace-id',
      '/hsm-bmt/observability/amg-workspace-url',
      '/hsm-bmt/observability/adot-config-s3-key',
      '/hsm-bmt/observability/alert-sns-topic-arn',
    ];
    const params = t.findResources('AWS::SSM::Parameter');
    const names = Object.values(params).map((p) => (p as { Properties: { Name: string } }).Properties.Name);
    for (const e of expected) expect(names).toContain(e);
  });
});
