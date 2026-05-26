import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * CryptoConstruct declares empty Secret resources only.
 * The CA private key is populated by the Cluster-Init Lambda Custom Resource
 * (see HsmClusterConstruct). This construct does NOT generate certs.
 */
export class CryptoConstruct extends Construct {
  public readonly caSecret: secretsmanager.Secret;
  public readonly coPasswordSecret: secretsmanager.Secret;
  public readonly cuPasswordSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // CA private key - empty placeholder; populated by Cluster-Init Lambda
    this.caSecret = new secretsmanager.Secret(this, 'CaSecret', {
      secretName: 'hsm-bmt/ca-private-key',
      description: 'BMT-only ephemeral CA (populated by Cluster-Init Lambda); not delivered to customer per Q9',
    });

    this.coPasswordSecret = new secretsmanager.Secret(this, 'CoPasswordSecret', {
      secretName: 'hsm-bmt/co-password',
      description: 'CloudHSM Crypto Officer password',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    this.cuPasswordSecret = new secretsmanager.Secret(this, 'CuPasswordSecret', {
      secretName: 'hsm-bmt/cu-password',
      description: 'CloudHSM Crypto User (benchmark workload) password',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
  }
}
