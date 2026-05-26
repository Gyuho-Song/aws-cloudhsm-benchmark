import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CoreStack } from '../lib/core-stack';

/**
 * Regression-only snapshot. Update with `npm test -- -u` after intentional CFN changes.
 * NOT part of the TDD red-green-refactor cycle.
 */
describe('CoreStack snapshot regression', () => {
  test('CFN template snapshot (desiredHsmCount=6 default)', () => {
    const app = new cdk.App();
    const stack = new CoreStack(app, 'CoreStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
    const t = Template.fromStack(stack);
    expect(t.toJSON()).toMatchSnapshot();
  });
});
