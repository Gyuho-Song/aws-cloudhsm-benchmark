import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';

export interface CognitoConstructProps {
  readonly envSuffix: string;
  /** Initial callback URLs (CloudFront domain typically); operator can add more later. */
  readonly callbackUrls?: string[];
  readonly logoutUrls?: string[];
}

export class CognitoConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly operatorGroup: cognito.CfnUserPoolGroup;
  /** U-CH-1: customer admin group (full access). */
  public readonly adminGroup: cognito.CfnUserPoolGroup;
  /** U-CH-1: customer viewer group (read-only). */
  public readonly viewerGroup: cognito.CfnUserPoolGroup;

  constructor(scope: Construct, id: string, props: CognitoConstructProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `hsm-bmt-${props.envSuffix}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('SpaClient', {
      userPoolClientName: 'hsm-bmt-spa',
      authFlows: { userSrp: true },
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: props.callbackUrls ?? ['https://example.com/callback'],
        logoutUrls: props.logoutUrls ?? ['https://example.com/logout'],
      },
      preventUserExistenceErrors: true,
      // Cognito hard maximums: access/id 24h, refresh 10 years (3650d).
      accessTokenValidity: cdk.Duration.hours(24),
      idTokenValidity: cdk.Duration.hours(24),
      refreshTokenValidity: cdk.Duration.days(3650),
    });

    this.userPoolDomain = this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: `hsm-bmt-${props.envSuffix}` },
    });

    this.operatorGroup = new cognito.CfnUserPoolGroup(this, 'OperatorGroup', {
      groupName: 'BmtOperator',
      userPoolId: this.userPool.userPoolId,
      description: 'CloudHSM BMT operators (<PARTNER> + AWS SA + ISV)',
    });

    // U-CH-1: customer admin/viewer groups (FR-CH-1.1).
    this.adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      groupName: 'admin',
      userPoolId: this.userPool.userPoolId,
      description: 'Customer admin — start/abort runs (FR-CH-1.2)',
    });
    this.viewerGroup = new cognito.CfnUserPoolGroup(this, 'ViewerGroup', {
      groupName: 'viewer',
      userPoolId: this.userPool.userPoolId,
      description: 'Customer viewer — read-only',
    });
  }
}
