import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WebStack } from '../lib/web-stack';

function synth(): Template {
  const app = new cdk.App();
  const stack = new WebStack(app, 'WebStack', {
    env: { account: '111111111111', region: 'ap-northeast-2' },
    envSuffix: 'test',
  });
  return Template.fromStack(stack);
}

describe('WebStack integration', () => {
  test('synth produces all expected resource categories', () => {
    const t = synth();
    t.resourceCountIs('AWS::DynamoDB::Table', 2); // bmt-runs + bmt-units
    t.resourceCountIs('AWS::Cognito::UserPool', 1);
    t.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    t.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    t.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    // 7 Lambdas
    const fns = t.findResources('AWS::Lambda::Function');
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(7);
  });

  test('publishes 9 SSM parameters under /hsm-bmt/web/', () => {
    const t = synth();
    const expected = [
      '/hsm-bmt/web/cognito-user-pool-id',
      '/hsm-bmt/web/cognito-app-client-id',
      '/hsm-bmt/web/cognito-hosted-ui-domain',
      '/hsm-bmt/web/api-endpoint',
      '/hsm-bmt/web/cloudfront-domain',
      '/hsm-bmt/web/frontend-bucket',
      '/hsm-bmt/web/runs-table-name',
      '/hsm-bmt/web/units-table-name',
      '/hsm-bmt/web/abort-ssm-prefix',
    ];
    const params = t.findResources('AWS::SSM::Parameter');
    const names = Object.values(params).map((p) => (p as { Properties: { Name: string } }).Properties.Name);
    for (const e of expected) expect(names).toContain(e);
  });

  test('runs table has GSI status-startedAt + PITR', () => {
    const t = synth();
    t.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({
      TableName: 'bmt-runs',
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: 'status-startedAt' })]),
      PointInTimeRecoverySpecification: Match.objectLike({ PointInTimeRecoveryEnabled: true }),
    }));
  });

  test('units table has GSI runId-status + PITR', () => {
    const t = synth();
    t.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({
      TableName: 'bmt-units',
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: 'runId-status' })]),
      PointInTimeRecoverySpecification: Match.objectLike({ PointInTimeRecoveryEnabled: true }),
    }));
  });

  test('Cognito user pool has email signin + OPTIONAL MFA', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({
      UsernameAttributes: Match.arrayWith(['email']),
      MfaConfiguration: 'OPTIONAL',
    }));
  });

  test('REST API has Cognito authorizer', () => {
    const t = synth();
    t.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    t.hasResourceProperties('AWS::ApiGateway::Authorizer', Match.objectLike({
      Type: 'COGNITO_USER_POOLS',
    }));
  });
});
