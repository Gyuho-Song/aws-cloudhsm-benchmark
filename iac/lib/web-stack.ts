import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'node:path';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { CognitoConstruct } from './constructs/cognito-construct';
import { DynamoDbConstruct } from './constructs/dynamodb-construct';
import { ApiConstruct } from './constructs/api-construct';
import { FrontendConstruct } from './constructs/frontend-construct';
import { AuthLambdasConstruct } from './constructs/auth-lambdas-construct';
import { AuthAlarmsConstruct } from './constructs/auth-alarms-construct';
import * as cognito from 'aws-cdk-lib/aws-cognito';

const SSM_WEB_PREFIX = '/hsm-bmt/web';
const SSM_CORE_PREFIX = '/hsm-bmt/core';
const SSM_OBS_PREFIX = '/hsm-bmt/observability';
const ABORT_SSM_PREFIX = '/hsm-bmt/runs/';

export interface WebStackProps extends cdk.StackProps {
  readonly envSuffix: string;
  /**
   * U-CH-1 Stage A vs C flag.
   *  - false (default): keep built-in Cognito authorizer. Stage A = group/Lambda/alarm only.
   *  - true: swap API Gateway authorizer to custom Lambda. Stage C = lockout-safe deploy
   *          (requires Stage B manual user→admin migration first).
   */
  readonly enableCustomAuthorizer?: boolean;
  /**
   * Multi-region loader instances. Default = [this stack's region]. When set
   * (e.g. ['ap-northeast-2', 'us-west-2']), api-construct expands the
   * lambda IAM policy and SSM lookup so start-run/abort-run can dispatch to
   * loaders in any of the listed regions, selected by run.region. Plumbing
   * is wired in Phase 2 of the multi-cluster scale-out plan; declaring the
   * prop here keeps the bin/hsm-bmt.ts entry point self-consistent.
   */
  readonly loaderRegions?: string[];
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    // Read upstream outputs from SSM Parameter Store
    const loaderInstanceId = ssm.StringParameter.valueForStringParameter(this, `${SSM_CORE_PREFIX}/loader-instance-id`);
    const resultsBucketName = ssm.StringParameter.valueForStringParameter(this, `${SSM_CORE_PREFIX}/s3-bucket-name`);
    const ampWorkspaceArn = ssm.StringParameter.valueForStringParameter(this, `${SSM_OBS_PREFIX}/amp-workspace-id`);
    const ampPrometheusEndpoint = ssm.StringParameter.valueForStringParameter(this, `${SSM_OBS_PREFIX}/amp-prometheus-endpoint`);

    // 2026-05-24 multi-cluster scale-out: extra-region loader instanceId +
    // bucket name come from CDK context. Cross-region SSM lookup at synth-
    // time is not supported by CDK's standard valueForStringParameter; the
    // operator runs us-west-2 cluster-create.sh first, then redeploys
    // apne2 WebStack with:
    //   --context loaderInstanceId-us-west-2=i-0xxxxx
    //   --context resultsBucket-us-west-2=hsm-bmt-results-...-us-west-2
    // The lambda code itself reads LOADER_INSTANCE_ID_BY_REGION /
    // RESULTS_BUCKET_BY_REGION env CSV at runtime, so cross-region IAM is
    // wired but the ARNs are baked at synth time.
    const homeRegion = cdk.Stack.of(this).region;
    const extraRegions = (props.loaderRegions ?? []).filter((r) => r !== homeRegion);
    const extraLoaderRegions = extraRegions.map((region) => {
      const instanceId = (this.node.tryGetContext(`loaderInstanceId-${region}`) as string | undefined);
      const bucketName = (this.node.tryGetContext(`resultsBucket-${region}`) as string | undefined);
      if (!instanceId || !bucketName) {
        throw new Error(
          `loaderRegions includes ${region} but missing context: ` +
          `--context loaderInstanceId-${region}=... --context resultsBucket-${region}=...`,
        );
      }
      return { region, instanceId, bucketName };
    });

    const ddb = new DynamoDbConstruct(this, 'Ddb');

    // Frontend first so the CloudFront domain is available for Cognito callback URLs
    const frontend = new FrontendConstruct(this, 'Frontend', { envSuffix: props.envSuffix });
    const frontendOrigin = `https://${frontend.distribution.distributionDomainName}`;

    const cognitoConstruct = new CognitoConstruct(this, 'Cognito', {
      envSuffix: props.envSuffix,
      callbackUrls: [`${frontendOrigin}/callback`],
      logoutUrls: [`${frontendOrigin}/logout`],
    });

    // U-CH-1: Auth Lambdas (PreTokenGen V2 + Custom Authorizer).
    const authLambdas = new AuthLambdasConstruct(this, 'AuthLambdas', {
      userPool: cognitoConstruct.userPool,
      userPoolClient: cognitoConstruct.userPoolClient,
      sessionsTable: ddb.adminSessionsTable,
    });

    // U-CH-1: Cognito V2 trigger sub-attach (escape hatch — CDK L2 may not
    // expose V2 directly. Use addPropertyOverride to avoid clashing with
    // any built-in lambdaConfig token resolution.)
    const cfnUserPool = cognitoConstruct.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.addPropertyOverride('UserPoolTier', 'ESSENTIALS');
    cfnUserPool.addPropertyOverride('LambdaConfig.PreTokenGenerationConfig.LambdaArn',
      authLambdas.preTokenGenFn.functionArn);
    cfnUserPool.addPropertyOverride('LambdaConfig.PreTokenGenerationConfig.LambdaVersion', 'V2_0');

    // U-CH-1: 5 alarms reusing existing observability SNS topic.
    const alertTopicArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${SSM_OBS_PREFIX}/alert-sns-topic-arn`,
    );
    new AuthAlarmsConstruct(this, 'AuthAlarms', {
      preTokenGenFn: authLambdas.preTokenGenFn,
      authorizerFn: authLambdas.authorizerFn,
      sessionsTable: ddb.adminSessionsTable,
      alertTopicArn,
    });

    const api = new ApiConstruct(this, 'Api', {
      userPool: cognitoConstruct.userPool,
      runsTable: ddb.runsTable,
      unitsTable: ddb.unitsTable,
      runsLockTable: ddb.runsLockTable,
      loaderInstanceId,
      resultsBucketName,
      ampWorkspaceArn,
      ampPrometheusEndpoint,
      abortSsmPathPrefix: ABORT_SSM_PREFIX,
      allowedCorsOrigins: [frontendOrigin],
      // U-CH-1: Stage C only — pass custom authorizer Lambda (else built-in Cognito retained)
      customAuthorizerFn: props.enableCustomAuthorizer ? authLambdas.authorizerFn : undefined,
      frontendOrigin,
      extraLoaderRegions,
    });

    publishParam(this, 'CognitoUserPoolIdParam', 'cognito-user-pool-id', cognitoConstruct.userPool.userPoolId);
    publishParam(this, 'CognitoAppClientIdParam', 'cognito-app-client-id', cognitoConstruct.userPoolClient.userPoolClientId);
    publishParam(this, 'CognitoDomainParam', 'cognito-hosted-ui-domain', cognitoConstruct.userPoolDomain.domainName);
    publishParam(this, 'ApiEndpointParam', 'api-endpoint', api.api.url);
    publishParam(this, 'CloudFrontDomainParam', 'cloudfront-domain', frontend.distribution.distributionDomainName);
    publishParam(this, 'FrontendBucketParam', 'frontend-bucket', frontend.bucket.bucketName);
    publishParam(this, 'RunsTableNameParam', 'runs-table-name', ddb.runsTable.tableName);
    publishParam(this, 'UnitsTableNameParam', 'units-table-name', ddb.unitsTable.tableName);
    publishParam(this, 'AbortSsmPrefixParam', 'abort-ssm-prefix', ABORT_SSM_PREFIX);
    // U-CH-6 G4: smoke script needs Lambda function names to PutMetricData
    // for AC-12 alarm verification.
    publishParam(this, 'PreTokenGenFnNameParam', 'pretokengen-fn-name',
      authLambdas.preTokenGenFn.functionName);
    publishParam(this, 'AuthorizerFnNameParam', 'authorizer-fn-name',
      authLambdas.authorizerFn.functionName);

    // Report renderer trigger: fires when a run row flips to COMPLETED.
    // It runs render-report.sh on the loader EC2 (which has all the boto/
    // pyarrow/weasyprint deps installed by user-data).
    const reportTrigger = new NodejsFunction(this, 'ReportTriggerFn', {
      entry: path.join(__dirname, '..', 'lambda', 'report-trigger', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        LOADER_INSTANCE_ID: loaderInstanceId,
        RESULTS_BUCKET: resultsBucketName,
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    reportTrigger.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: ['*'],
    }));
    reportTrigger.addEventSource(new DynamoEventSource(ddb.runsTable as dynamodb.Table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 5,
      retryAttempts: 1,
    }));

    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${frontend.distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'CognitoHostedUi', { value: `https://${cognitoConstruct.userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com` });
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: api.api.url });
  }
}

function publishParam(scope: Construct, id: string, name: string, value: string): ssm.StringParameter {
  return new ssm.StringParameter(scope, id, {
    parameterName: `${SSM_WEB_PREFIX}/${name}`,
    stringValue: value,
  });
}
