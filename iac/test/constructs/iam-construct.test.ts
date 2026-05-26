import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IamConstruct } from '../../lib/constructs/iam-construct';

function synthStack(ctx?: { sdsAccountId?: string; sdsExternalId?: string }): Template {
  const app = new cdk.App({ context: ctx });
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  new IamConstruct(stack, 'Iam', {
    sdsAccountId: ctx?.sdsAccountId ?? '999999999999',
    sdsExternalId: ctx?.sdsExternalId ?? 'test-external-id',
  });
  return Template.fromStack(stack);
}

describe('IamConstruct', () => {
  // Behavior 2.1
  test('LoaderInstanceRole has AmazonSSMManagedInstanceCore attached', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::IAM::Role', Match.objectLike({
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ec2.amazonaws.com' },
          }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('AmazonSSMManagedInstanceCore')]),
          ]),
        }),
      ]),
    }));
  });

  // Behavior 2.2
  test('LoaderInstanceRole has explicit allow statements (no wildcard for write actions)', () => {
    const t = synthStack();
    const policies = t.findResources('AWS::IAM::Policy');
    let hasS3Put = false;
    let hasDdbPut = false;
    let hasApsRemoteWrite = false;
    let hasSecretsRead = false;
    for (const [, policy] of Object.entries(policies)) {
      const doc = (policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource?: unknown }> } } }).Properties.PolicyDocument;
      for (const s of doc.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (actions.includes('s3:PutObject') || actions.includes('s3:*')) {
          hasS3Put = true;
          expect(s.Resource).not.toBe('*');
        }
        if (actions.includes('dynamodb:PutItem')) {
          hasDdbPut = true;
          expect(s.Resource).not.toBe('*');
        }
        if (actions.includes('aps:RemoteWrite')) {
          hasApsRemoteWrite = true;
        }
        if (actions.includes('secretsmanager:GetSecretValue')) {
          hasSecretsRead = true;
        }
      }
    }
    expect(hasS3Put).toBe(true);
    expect(hasDdbPut).toBe(true);
    expect(hasApsRemoteWrite).toBe(true);
    expect(hasSecretsRead).toBe(true);
  });

  // Behavior 2.3
  test('OperatorRole trust policy includes <PARTNER> account principal and ExternalId condition', () => {
    const t = synthStack({ sdsAccountId: '123456789012', sdsExternalId: 'hsm-bmt-handoff' });
    const roles = t.findResources('AWS::IAM::Role');
    let foundOperator = false;
    for (const [, res] of Object.entries(roles)) {
      const props = (res as { Properties: { AssumeRolePolicyDocument: { Statement: Array<Record<string, unknown>> } } }).Properties;
      for (const s of props.AssumeRolePolicyDocument.Statement) {
        const principal = s.Principal as { AWS?: unknown } | undefined;
        const principalStr = JSON.stringify(principal);
        if (principalStr && principalStr.includes('123456789012')) {
          foundOperator = true;
          const cond = s.Condition as { StringEquals?: Record<string, string> } | undefined;
          expect(cond?.StringEquals).toEqual(expect.objectContaining({ 'sts:ExternalId': 'hsm-bmt-handoff' }));
        }
      }
    }
    expect(foundOperator).toBe(true);
  });

  // Behavior 2.4
  test('No write-action policy uses Resource: "*"', () => {
    const t = synthStack();
    const policies = t.findResources('AWS::IAM::Policy');
    const writeActions = ['s3:PutObject', 's3:*', 'dynamodb:PutItem', 'secretsmanager:PutSecretValue'];
    for (const [, policy] of Object.entries(policies)) {
      const doc = (policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource?: unknown }> } } }).Properties.PolicyDocument;
      for (const s of doc.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        for (const a of writeActions) {
          if (actions.includes(a)) {
            expect(s.Resource).not.toBe('*');
          }
        }
      }
    }
  });
});
