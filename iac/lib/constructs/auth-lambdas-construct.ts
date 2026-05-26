import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'node:path';

const WEB_API_ROOT = path.join(__dirname, '..', '..', '..', 'web-api');
const LAMBDA_SRC = path.join(WEB_API_ROOT, 'src');

export interface AuthLambdasConstructProps {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly sessionsTable: dynamodb.ITable;
}

/**
 * U-CH-1 Auth Lambdas: Pre-Token-Generation V2 + Custom REQUEST Authorizer.
 * IAM least-privilege (PutItem+GetItem / GetItem only). LogGroup retention 30d.
 */
export class AuthLambdasConstruct extends Construct {
  public readonly preTokenGenFn: NodejsFunction;
  public readonly authorizerFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: AuthLambdasConstructProps) {
    super(scope, id);

    this.preTokenGenFn = new NodejsFunction(this, 'PreTokenGenFn', {
      entry: path.join(LAMBDA_SRC, 'pre-token-gen.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      environment: {
        ADMIN_SESSIONS_TABLE: props.sessionsTable.tableName,
      },
      projectRoot: WEB_API_ROOT,
      depsLockFilePath: path.join(WEB_API_ROOT, 'package-lock.json'),
      bundling: { externalModules: ['@aws-sdk/*'] },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    this.preTokenGenFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
      resources: [props.sessionsTable.tableArn],
    }));
    this.preTokenGenFn.addPermission('CognitoInvoke', {
      principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      sourceArn: props.userPool.userPoolArn,
      sourceAccount: cdk.Stack.of(this).account,
    });

    this.authorizerFn = new NodejsFunction(this, 'CustomAuthorizerFn', {
      entry: path.join(LAMBDA_SRC, 'custom-authorizer.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(5),
      environment: {
        ADMIN_SESSIONS_TABLE: props.sessionsTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
      },
      projectRoot: WEB_API_ROOT,
      depsLockFilePath: path.join(WEB_API_ROOT, 'package-lock.json'),
      bundling: { externalModules: ['@aws-sdk/*'] },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    this.authorizerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [props.sessionsTable.tableArn],
    }));
  }
}
