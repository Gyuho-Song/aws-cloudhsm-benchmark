import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AmgConstruct } from '../../lib/constructs/amg-construct';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  new AmgConstruct(stack, 'Amg', { envSuffix: 'test' });
  return Template.fromStack(stack);
}

describe('AmgConstruct', () => {
  test('creates Grafana workspace with PROMETHEUS + CLOUDWATCH datasources', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Grafana::Workspace', Match.objectLike({
      Name: 'hsm-bmt-test',
      AccountAccessType: 'CURRENT_ACCOUNT',
      AuthenticationProviders: ['AWS_SSO'],
      PermissionType: 'SERVICE_MANAGED',
      DataSources: Match.arrayWith(['PROMETHEUS', 'CLOUDWATCH']),
    }));
  });

  test('service role grants aps:QueryMetrics + cloudwatch read', () => {
    const t = synth();
    const policies = t.findResources('AWS::IAM::Policy');
    let hasApsQuery = false;
    let hasCwRead = false;
    for (const [, p] of Object.entries(policies)) {
      const doc = (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }).Properties.PolicyDocument;
      for (const s of doc.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (actions.includes('aps:QueryMetrics')) hasApsQuery = true;
        if (actions.includes('cloudwatch:GetMetricData')) hasCwRead = true;
      }
    }
    expect(hasApsQuery).toBe(true);
    expect(hasCwRead).toBe(true);
  });
});
