import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { RepositoryConstruct } from '../../lib/constructs/repository-construct';

function synthStack(provider: 'codecommit' | 'github'): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  new RepositoryConstruct(stack, 'Repo', { provider });
  return Template.fromStack(stack);
}

describe('RepositoryConstruct', () => {
  test('codecommit: creates a CodeCommit repository named hsm-bmt', () => {
    const t = synthStack('codecommit');
    t.hasResourceProperties('AWS::CodeCommit::Repository', Match.objectLike({
      RepositoryName: 'hsm-bmt',
    }));
    t.resourceCountIs('AWS::SSM::Parameter', 0);
  });

  test('github: creates SSM parameter with handoff instructions, no CodeCommit', () => {
    const t = synthStack('github');
    t.resourceCountIs('AWS::CodeCommit::Repository', 0);
    t.hasResourceProperties('AWS::SSM::Parameter', Match.objectLike({
      Name: '/hsm-bmt/core/repo-instructions',
    }));
  });
});
