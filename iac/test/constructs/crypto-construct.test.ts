import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CryptoConstruct } from '../../lib/constructs/crypto-construct';

function synthStack(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  new CryptoConstruct(stack, 'Crypto');
  return Template.fromStack(stack);
}

describe('CryptoConstruct', () => {
  // Behavior 3.1
  test('CA private key Secrets Manager secret exists with name hsm-bmt/ca-private-key', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::SecretsManager::Secret', Match.objectLike({
      Name: 'hsm-bmt/ca-private-key',
    }));
  });

  // Behavior 3.2 — CO password
  test('CO password secret generated with 32-char passwordLength', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::SecretsManager::Secret', Match.objectLike({
      Name: 'hsm-bmt/co-password',
      GenerateSecretString: Match.objectLike({
        PasswordLength: 32,
        ExcludePunctuation: true,
      }),
    }));
  });

  // Behavior 3.2 — CU password
  test('CU password secret generated with 32-char passwordLength', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::SecretsManager::Secret', Match.objectLike({
      Name: 'hsm-bmt/cu-password',
      GenerateSecretString: Match.objectLike({
        PasswordLength: 32,
        ExcludePunctuation: true,
      }),
    }));
  });

  test('all 3 secrets are present', () => {
    const t = synthStack();
    t.resourceCountIs('AWS::SecretsManager::Secret', 3);
  });
});
