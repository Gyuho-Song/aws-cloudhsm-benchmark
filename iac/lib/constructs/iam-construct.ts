import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';

export interface IamConstructProps {
  /** <PARTNER> account that will assume OperatorRole. */
  readonly sdsAccountId: string;
  /** ExternalId condition for cross-account assume-role. */
  readonly sdsExternalId: string;
  /** Optional resource ARN hooks; when omitted, scoped to predictable BMT resources. */
  readonly resultsBucketArnPattern?: string;
  readonly secretsArnPattern?: string;
  readonly dynamoDbTableArnPattern?: string;
  readonly ampWorkspaceArnPattern?: string;
}

export class IamConstruct extends Construct {
  public readonly loaderInstanceRole: iam.Role;
  public readonly operatorRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamConstructProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    const resultsBucketArn = props.resultsBucketArnPattern ?? `arn:aws:s3:::hsm-bmt-results-${account}-${region}`;
    const secretsPrefix = props.secretsArnPattern ?? `arn:aws:secretsmanager:${region}:${account}:secret:hsm-bmt/*`;
    const ddbArn = props.dynamoDbTableArnPattern ?? `arn:aws:dynamodb:${region}:${account}:table/bmt-*`;
    const ampArn = props.ampWorkspaceArnPattern ?? `arn:aws:aps:${region}:${account}:workspace/*`;

    this.loaderInstanceRole = new iam.Role(this, 'LoaderInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      description: 'BMT loader EC2 instance role - least-privilege scoped to hsm-bmt resources',
    });

    // Secrets Manager: read CA + CO + CU under hsm-bmt/*
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [secretsPrefix],
    }));

    // S3: full access scoped to results bucket (no production data in BMT phase 1).
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:*'],
      resources: [resultsBucketArn, `${resultsBucketArn}/*`],
    }));

    // KMS: needed for SSE-KMS PUT/GET on the results bucket. aws/s3 default key
    // is permissive enough by default but explicit perms make this work in
    // accounts that lock down the default key.
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
      resources: ['*'],
    }));

    // AMP RemoteWrite
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['aps:RemoteWrite', 'aps:GetSeries', 'aps:GetLabels', 'aps:GetMetricMetadata'],
      resources: [ampArn],
    }));

    // CloudHSM describe (IAM actions live under `cloudhsm:` service prefix)
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudhsm:DescribeClusters', 'cloudhsm:DescribeBackups'],
      resources: ['*'], // Describe APIs only support `*`
    }));

    // 2026-05-24 hard scale: cloudhsm + EC2 networking for DeleteHsm/CreateHsm.
    // Used by hard-scale-cluster.sh (called from hsm-bmt-orchestrate.sh when
    // HSM_BMT_HARD_SCALE=1). Wildcards on EC2 NIC/SG verbs because CloudHSM's
    // create-hsm path internally creates the ENI + SG; locking down to a
    // hand-curated action list keeps tripping over edge-case verbs (observed
    // 2026-05-24 with ec2:DeleteNetworkInterface missing). All resource `*`
    // since these APIs do not support resource-level IAM.
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudHsmFull',
      actions: ['cloudhsm:*'],
      resources: ['*'],
    }));
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'Ec2NetworkingForHsm',
      actions: [
        'ec2:*NetworkInterface*',
        'ec2:*SecurityGroup*',
        'ec2:Describe*',
        'ec2:CreateTags',
        'ec2:DeleteTags',
      ],
      resources: ['*'],
    }));
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ServiceLinkedRoleForCloudHsm',
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['*'],
    }));

    // DynamoDB: write run/unit state
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:Query'],
      resources: [ddbArn, `${ddbArn}/index/*`],
    }));

    // CloudWatch Logs + Metrics
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [`arn:aws:logs:${region}:${account}:log-group:/hsm-bmt/*`],
    }));
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'], // PutMetricData only supports `*`
      conditions: { StringEquals: { 'cloudwatch:namespace': ['CloudHSM-BMT', 'AWS/CloudHSM'] } },
    }));

    // SSM Parameter Store reads (abort signal etc.) and writes for the
    // loader-build script (writes /hsm-bmt/loader/{version-id,sha256}).
    this.loaderInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath',
                'ssm:PutParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/hsm-bmt/*`],
    }));

    // OperatorRole - cross-account read access for <PARTNER>.
    // If sdsAccountId is the placeholder '000000000000', fall back to the current
    // account so the role provisions cleanly; operator updates the trust policy
    // before <PARTNER> handoff.
    const trustAccountId = props.sdsAccountId === '000000000000' ? account : props.sdsAccountId;
    this.operatorRole = new iam.Role(this, 'OperatorRole', {
      assumedBy: new iam.AccountPrincipal(trustAccountId),
      externalIds: [props.sdsExternalId],
      description: 'Cross-account read role for <PARTNER> to consume BMT results during Phase 2',
    });
    this.operatorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resources: [
        resultsBucketArn,
        `${resultsBucketArn}/runs/*`,
        `${resultsBucketArn}/reports/*`,
      ],
    }));
  }
}
