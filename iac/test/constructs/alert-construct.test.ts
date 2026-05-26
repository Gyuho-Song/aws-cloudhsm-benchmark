import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AlertConstruct } from '../../lib/constructs/alert-construct';

describe('AlertConstruct', () => {
  test('creates SNS topic with expected name', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
    new AlertConstruct(stack, 'Alert', { envSuffix: 'test' });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::SNS::Topic', Match.objectLike({
      TopicName: 'hsm-bmt-alerts-test',
      DisplayName: 'CloudHSM BMT alerts',
    }));
  });
});
