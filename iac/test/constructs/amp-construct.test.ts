import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AmpConstruct } from '../../lib/constructs/amp-construct';

function synth(expectedHsms = 6): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  new AmpConstruct(stack, 'Amp', {
    envSuffix: 'test',
    loaderRoleArn: 'arn:aws:iam::111111111111:role/LoaderRole',
    expectedHsms,
    snsTopicArn: 'arn:aws:sns:ap-northeast-2:111111111111:hsm-bmt-alerts-test',
  });
  return Template.fromStack(stack);
}

describe('AmpConstruct', () => {
  test('creates AMP workspace with alias and tags', () => {
    const t = synth();
    t.hasResourceProperties('AWS::APS::Workspace', Match.objectLike({
      Alias: 'hsm-bmt-test',
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'hsm-bmt:role', Value: 'metrics' }),
      ]),
    }));
  });

  test('creates rule groups namespace named hsm-bmt-rules', () => {
    const t = synth();
    t.hasResourceProperties('AWS::APS::RuleGroupsNamespace', Match.objectLike({
      Name: 'hsm-bmt-rules',
    }));
  });

  test('rule namespace YAML contains all 6 alert names', () => {
    const t = synth();
    const rgs = t.findResources('AWS::APS::RuleGroupsNamespace');
    const data = (Object.values(rgs)[0] as { Properties: { Data: string } }).Properties.Data;
    expect(data).toContain('HSM-Latency-P99-High');
    expect(data).toContain('HSM-Error-Rate-High');
    expect(data).toContain('HSM-Pool-Saturation');
    expect(data).toContain('HSM-Queue-Wait-Spike');
    expect(data).toContain('HSM-Failover-Storm');
    expect(data).toContain('HSM-Cluster-Degraded');
  });

  test('expectedHsms substituted into HSM-Cluster-Degraded threshold', () => {
    const t6 = synth(6);
    const data6 = (Object.values(t6.findResources('AWS::APS::RuleGroupsNamespace'))[0] as { Properties: { Data: string } }).Properties.Data;
    expect(data6).toContain('< 6');
    expect(data6).not.toContain('${EXPECTED_HSMS}');

    const t2 = synth(2);
    const data2 = (Object.values(t2.findResources('AWS::APS::RuleGroupsNamespace'))[0] as { Properties: { Data: string } }).Properties.Data;
    expect(data2).toContain('< 2');
  });

  test('Alert Manager definition resource exists with SNS topic ARN substituted', () => {
    const t = synth();
    const am = t.findResources('AWS::APS::AlertManagerDefinition');
    expect(Object.keys(am)).toHaveLength(1);
    const data = (Object.values(am)[0] as { Properties: { Data: string } }).Properties.Data;
    expect(data).toContain('arn:aws:sns:ap-northeast-2:111111111111:hsm-bmt-alerts-test');
    expect(data).not.toContain('${SNS_TOPIC_ARN}');
  });

  test('grants aps:RemoteWrite to loader role', () => {
    const t = synth();
    t.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'aps:RemoteWrite',
          }),
        ]),
      }),
    }));
  });
});
