import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'node:path';

export interface ApiConstructProps {
  readonly userPool: cognito.IUserPool;
  readonly runsTable: dynamodb.ITable;
  readonly unitsTable: dynamodb.ITable;
  /** U-CH-2: Run-level concurrency lock table (single global row). */
  readonly runsLockTable: dynamodb.ITable;
  readonly loaderInstanceId: string;
  readonly resultsBucketName: string;
  readonly ampWorkspaceArn: string;
  readonly ampPrometheusEndpoint: string;
  readonly abortSsmPathPrefix: string;
  readonly allowedCorsOrigins: string[];
  /** U-CH-1: Stage C — when set, swap built-in Cognito authorizer to this. */
  readonly customAuthorizerFn?: lambda.IFunction;
  /** U-CH-1: frontend origin for GatewayResponse CORS headers (single source of truth with allowedCorsOrigins[0]). */
  readonly frontendOrigin?: string;
  /**
   * 2026-05-24 multi-cluster scale-out: extra regions where the loader EC2
   * + result S3 bucket also live. When set, lambda IAM is expanded to allow
   * SSM SendCommand / S3 GetObject in those regions, and the env carries
   * region→instance/bucket maps so start-run / abort-run / report-* can
   * dispatch cross-region based on run.region. Default = empty (single-
   * region apne2 — preserves existing behavior).
   *
   * Each entry: region | instanceId | bucketName
   * Example:
   *   [
   *     { region: 'us-west-2', instanceId: 'i-0abc...', bucketName: 'hsm-bmt-results-...-us-west-2' }
   *   ]
   */
  readonly extraLoaderRegions?: ReadonlyArray<{
    readonly region: string;
    readonly instanceId: string;
    readonly bucketName: string;
  }>;
}

const LAMBDA_SRC = path.join(__dirname, '..', '..', '..', 'web-api', 'src');

export class ApiConstruct extends Construct {
  public readonly api: apigw.RestApi;
  /** Built-in Cognito authorizer (Stage A) or undefined (Stage C, custom in use). */
  public readonly authorizer?: apigw.CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: 'hsm-bmt-web-api',
      deployOptions: { stageName: 'prod' },
      defaultCorsPreflightOptions: {
        allowOrigins: props.allowedCorsOrigins,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });

    // U-CH-1: Stage A vs Stage C — swap authorizer.
    let auth: apigw.MethodOptions;
    if (props.customAuthorizerFn) {
      const customAuthorizer = new apigw.RequestAuthorizer(this, 'CustomAuth', {
        handler: props.customAuthorizerFn,
        identitySources: [apigw.IdentitySource.header('Authorization')],
        resultsCacheTtl: cdk.Duration.seconds(0),
      });
      auth = {
        authorizer: customAuthorizer,
        authorizationType: apigw.AuthorizationType.CUSTOM,
      };
    } else {
      this.authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
        cognitoUserPools: [props.userPool],
      });
      auth = {
        authorizer: this.authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      };
    }

    // U-CH-1: GatewayResponse 401/403 with Korean reason body + CORS headers.
    if (props.frontendOrigin) {
      const corsHeaders = {
        'Access-Control-Allow-Origin': `'${props.frontendOrigin}'`,
        'Access-Control-Allow-Headers': "'Authorization,Content-Type'",
        'Access-Control-Allow-Credentials': "'true'",
      };

      // Authorizer Deny + context.error/reason → 401/403 분기 VTL.
      // Note: ACCESS_DENIED defaults to HTTP 403; we keep that and let the
      // frontend distinguish "session_invalidated" vs "forbidden" vs others
      // by inspecting the body's `error` field. The 401-vs-403 split was
      // attempted via #set($context.responseOverride.status = ...) but VTL
      // directives in GatewayResponse templates get truncated by API Gateway
      // (observed 2026-05-20). Frontend already branches on error code so
      // returning a plain 403 with the actual error/reason is sufficient.
      new apigw.GatewayResponse(this, 'GwAccessDenied', {
        restApi: this.api,
        type: apigw.ResponseType.ACCESS_DENIED,
        responseHeaders: corsHeaders,
        templates: {
          'application/json':
            '{"error":"$context.authorizer.error","reason":"$context.authorizer.reason"}',
        },
      });
      // Safety net: if authorizer throws (instead of Deny+context), default 401 body.
      new apigw.GatewayResponse(this, 'GwUnauthorized', {
        restApi: this.api,
        type: apigw.ResponseType.UNAUTHORIZED,
        statusCode: '401',
        responseHeaders: corsHeaders,
        templates: {
          'application/json': JSON.stringify({ error: 'unauthorized', reason: '인증 실패' }),
        },
      });
    }

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    // 2026-05-24 multi-cluster scale-out: aggregate region→loader/bucket maps.
    // Home region (this stack's region) plus any extraLoaderRegions.
    const allRegionsMap: ReadonlyArray<{ region: string; instanceId: string; bucketName: string }> = [
      { region, instanceId: props.loaderInstanceId, bucketName: props.resultsBucketName },
      ...(props.extraLoaderRegions ?? []),
    ];
    const loaderInstanceIdByRegionCsv = allRegionsMap
      .map((e) => `${e.region}:${e.instanceId}`)
      .join(',');
    const resultsBucketByRegionCsv = allRegionsMap
      .map((e) => `${e.region}:${e.bucketName}`)
      .join(',');

    const commonEnv = {
      RUNS_TABLE: props.runsTable.tableName,
      UNITS_TABLE: props.unitsTable.tableName,
      RUNS_LOCK_TABLE: props.runsLockTable.tableName,
      LOADER_INSTANCE_ID: props.loaderInstanceId,
      RESULTS_BUCKET: props.resultsBucketName,
      // Multi-region maps (lambda parses these). Always set; single-region
      // case carries just the home region entry — the lambda code handles
      // both formats identically.
      LOADER_INSTANCE_ID_BY_REGION: loaderInstanceIdByRegionCsv,
      RESULTS_BUCKET_BY_REGION: resultsBucketByRegionCsv,
      AMP_WORKSPACE_ARN: props.ampWorkspaceArn,
      AMP_PROMETHEUS_ENDPOINT: props.ampPrometheusEndpoint,
      ABORT_SSM_PREFIX: props.abortSsmPathPrefix,
    };

    const webApiRoot = path.join(__dirname, '..', '..', '..', 'web-api');
    const mkFn = (id: string, entry: string, extraPolicies: iam.PolicyStatement[] = []) => {
      const fn = new NodejsFunction(this, id, {
        entry: path.join(LAMBDA_SRC, entry),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        environment: commonEnv,
        projectRoot: webApiRoot,
        depsLockFilePath: path.join(webApiRoot, 'package-lock.json'),
        bundling: { externalModules: ['@aws-sdk/*'] },
      });
      for (const p of extraPolicies) fn.addToRolePolicy(p);
      return fn;
    };

    // SendCommand resource list expands across all regions (each region's
    // EC2 + SSM document ARN). Region-scoped ARN is required — SDK 5
    // SendCommand uses the client's region but SSM resource ARN is
    // region-keyed.
    const sendCommandResources = allRegionsMap.flatMap((e) => [
      `arn:aws:ec2:${e.region}:${account}:instance/${e.instanceId}`,
      `arn:aws:ssm:${e.region}::document/AWS-RunShellScript`,
    ]);

    const startRunFn = mkFn('StartRunFn', 'start-run.ts', [
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: sendCommandResources,
      }),
    ]);
    props.runsTable.grantReadWriteData(startRunFn);
    // U-CH-2: lock acquire/release + active-run lookup on conflict
    props.runsLockTable.grantReadWriteData(startRunFn);

    const abortRunFn = mkFn('AbortRunFn', 'abort-run.ts', [
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        // SSM Parameter (abort flag) lives on the loader's region too. Each
        // loader's polling reads /hsm-bmt/runs/<runId>/abort against its
        // own SSM service endpoint, so abort-run must put to the matching
        // region. Parameter path prefix is identical across regions.
        resources: allRegionsMap.map((e) =>
          `arn:aws:ssm:${e.region}:${account}:parameter${props.abortSsmPathPrefix}*`,
        ),
      }),
      // 2026-05-23: abort-run also fires SendCommand SIGTERM so the
      // orchestrator stops within ~1 s instead of waiting for the next
      // cooperative Param poll (≤ 5 s) plus the in-flight cell completion
      // (~6 min).
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: sendCommandResources,
      }),
    ]);
    props.runsTable.grantReadWriteData(abortRunFn);
    // U-CH-2: lock release on abort
    props.runsLockTable.grantReadWriteData(abortRunFn);

    const listRunsFn = mkFn('ListRunsFn', 'list-runs.ts');
    props.runsTable.grantReadData(listRunsFn);

    const getRunFn = mkFn('GetRunFn', 'get-run.ts');
    props.runsTable.grantReadData(getRunFn);
    props.unitsTable.grantReadData(getRunFn);

    const getRunStatusFn = mkFn('GetRunStatusFn', 'get-run-status.ts', [
      new iam.PolicyStatement({
        // Resource is "*" because the upstream value plumbed in is the raw
        // workspace ID (e.g. ws-...) rather than an ARN. AMP query actions
        // accept "*" without issue.
        actions: ['aps:QueryMetrics', 'aps:GetSeries', 'aps:GetLabels', 'aps:GetMetricMetadata'],
        resources: ['*'],
      }),
    ]);
    props.runsTable.grantReadData(getRunStatusFn);
    props.unitsTable.grantReadData(getRunStatusFn);

    const reportPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      // Multi-region: every region's result bucket is allowed. report-html-
      // redirect / report-pdf-redirect read run.region from DDB to pick the
      // right bucket; IAM must permit all of them.
      resources: allRegionsMap.flatMap((e) => [
        `arn:aws:s3:::${e.bucketName}`,
        `arn:aws:s3:::${e.bucketName}/*`,
      ]),
    });
    const kmsPolicy = new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:DescribeKey'],
      resources: ['*'],
    });
    const reportHtmlFn = mkFn('ReportHtmlFn', 'report-html-redirect.ts', [reportPolicy, kmsPolicy]);
    const reportPdfFn = mkFn('ReportPdfFn', 'report-pdf-redirect.ts', [reportPolicy, kmsPolicy]);

    const getLoaderInfoFn = mkFn('GetLoaderInfoFn', 'get-loader-info.ts', [
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [`arn:aws:ssm:${region}:${account}:parameter/hsm-bmt/loader/*`],
      }),
    ]);

    // 2026-05-25 HOS-Step4/Step6: cluster status + provision lambdas.
    // Both need cloudhsmv2:DescribeClusters + ssm:GetParameter on
    // /hsm-bmt/core/* (cluster-id, desired-hsm-count, cluster-state,
    // hard-scale-status). Provision additionally needs ssm:SendCommand
    // (loader EC2) and dynamodb:GetItem (bmt-runs-lock).
    const corePolicy = new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/hsm-bmt/core/*`],
    });
    const describeClustersPolicy = new iam.PolicyStatement({
      actions: ['cloudhsm:DescribeClusters'],
      resources: ['*'], // CloudHSM Describe APIs only support `*`
    });

    // start-run also needs to read cluster state for the pre-flight gate.
    startRunFn.addToRolePolicy(corePolicy);
    startRunFn.addToRolePolicy(describeClustersPolicy);

    const clusterStatusFn = mkFn('ClusterStatusFn', 'cluster-status.ts', [
      corePolicy,
      describeClustersPolicy,
    ]);

    const clusterProvisionFn = mkFn('ClusterProvisionFn', 'cluster-provision.ts', [
      corePolicy,
      describeClustersPolicy,
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        // Single-region (HOS retired multi-region maps).
        resources: [
          `arn:aws:ec2:${region}:${account}:instance/${props.loaderInstanceId}`,
          `arn:aws:ssm:${region}::document/AWS-RunShellScript`,
        ],
      }),
    ]);
    props.runsLockTable.grantReadData(clusterProvisionFn);

    // Phase F (cluster-state-rca-plan): admin-only emergency unlock.
    const clusterForceUnlockFn = mkFn('ClusterForceUnlockFn', 'cluster-force-unlock.ts', [
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [`arn:aws:ssm:${region}:${account}:parameter/hsm-bmt/core/cluster-state*`],
      }),
    ]);

    // Routes — `auth` 는 위 §"Stage A vs Stage C" 분기에서 결정됨.
    const runs = this.api.root.addResource('runs');
    runs.addMethod('POST', new apigw.LambdaIntegration(startRunFn), auth);
    runs.addMethod('GET', new apigw.LambdaIntegration(listRunsFn), auth);
    const run = runs.addResource('{id}');
    run.addMethod('GET', new apigw.LambdaIntegration(getRunFn), auth);
    run.addResource('abort').addMethod('POST', new apigw.LambdaIntegration(abortRunFn), auth);
    run.addResource('status').addMethod('GET', new apigw.LambdaIntegration(getRunStatusFn), auth);

    const reports = this.api.root.addResource('reports').addResource('{id}');
    reports.addMethod('GET', new apigw.LambdaIntegration(reportHtmlFn), auth);
    reports.addResource('pdf').addMethod('GET', new apigw.LambdaIntegration(reportPdfFn), auth);

    this.api.root.addResource('loader-info')
      .addMethod('GET', new apigw.LambdaIntegration(getLoaderInfoFn), auth);

    // HOS cluster routes
    const cluster = this.api.root.addResource('cluster');
    cluster.addResource('status')
      .addMethod('GET', new apigw.LambdaIntegration(clusterStatusFn), auth);
    cluster.addResource('provision')
      .addMethod('POST', new apigw.LambdaIntegration(clusterProvisionFn), auth);
    cluster.addResource('force-unlock')
      .addMethod('POST', new apigw.LambdaIntegration(clusterForceUnlockFn), auth);
  }
}
