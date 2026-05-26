import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AmpConstruct } from './constructs/amp-construct';
import { AmgConstruct } from './constructs/amg-construct';
import { AdotConfigConstruct } from './constructs/adot-config-construct';
import { AlertConstruct } from './constructs/alert-construct';
import { DashboardConstruct } from './constructs/dashboard-construct';

const SSM_OBS_PREFIX = '/hsm-bmt/observability';
const SSM_CORE_PREFIX = '/hsm-bmt/core';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly envSuffix: string;
  readonly expectedHsms: number;
  /** Optional operator emails to subscribe to the alert SNS topic. */
  readonly operatorEmails?: string[];
  /**
   * Whether to deploy the AMG (Grafana) workspace + dashboards in this stack.
   * Default true. Set false for satellite regions (e.g. us-west-2) where the
   * primary region's AMG queries this region's AMP via cross-region datasource
   * (AMP-adding-AWS-config.html — official multi-region support).
   */
  readonly deployAmg?: boolean;
}

export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    // Read CoreStack outputs from SSM Parameter Store
    const loaderRoleArn = ssm.StringParameter.valueForStringParameter(this, `${SSM_CORE_PREFIX}/loader-role-arn`);
    const s3BucketName = ssm.StringParameter.valueForStringParameter(this, `${SSM_CORE_PREFIX}/s3-bucket-name`);
    const resultsBucket = s3.Bucket.fromBucketName(this, 'ResultsBucketRef', s3BucketName);

    const alert = new AlertConstruct(this, 'Alert', {
      envSuffix: props.envSuffix,
      operatorEmails: props.operatorEmails,
    });

    // ap-northeast-2 (Seoul) supports AMP Workspaces + RuleGroupsNamespace but
    // not AlertManagerDefinition CFN type yet (verified 2026-05-17). Default
    // off when deploying to ap-northeast-2; operator applies alert-manager.yaml
    // via the AMP API after deploy.
    //
    // 2026-05-24: us-west-2 also lacks AWS::APS::AlertManagerDefinition CFN
    // type at this point (Template format error: "Unrecognized resource type"
    // observed during multi-cluster deploy). Disabled by default everywhere;
    // operator must opt in with --context emitAlertManagerDefinition=true.
    // String "true"/"false" comparison handles cdk.json + CLI both.
    const emitFlag = this.node.tryGetContext('emitAlertManagerDefinition');
    const emitAlertManagerDefinition = emitFlag === true || emitFlag === 'true';

    const amp = new AmpConstruct(this, 'Amp', {
      envSuffix: props.envSuffix,
      loaderRoleArn,
      expectedHsms: props.expectedHsms,
      snsTopicArn: alert.topic.topicArn,
      emitAlertManagerDefinition,
    });

    const deployAmg = props.deployAmg !== false;
    const amg = deployAmg
      ? new AmgConstruct(this, 'Amg', { envSuffix: props.envSuffix })
      : undefined;

    const adot = new AdotConfigConstruct(this, 'AdotConfig', {
      resultsBucket,
      loaderRoleArn,
      ampRemoteWriteUrl: amp.remoteWriteUrl,
    });

    if (amg) {
      new DashboardConstruct(this, 'Dashboards', {
        amgWorkspaceId: amg.workspace.attrId,
        amgWorkspaceUrl: amg.workspaceUrl,
        ampPrometheusEndpoint: amp.workspace.attrPrometheusEndpoint,
        cloudwatchRegion: this.region,
      });
    }

    // SSM cross-stack outputs under /hsm-bmt/observability/
    publishParam(this, 'AmpWorkspaceIdParam', 'amp-workspace-id', amp.workspace.attrWorkspaceId);
    publishParam(this, 'AmpPromEndpointParam', 'amp-prometheus-endpoint', amp.workspace.attrPrometheusEndpoint);
    publishParam(this, 'AmpRemoteWriteUrlParam', 'amp-remote-write-url', amp.remoteWriteUrl);
    if (amg) {
      publishParam(this, 'AmgWorkspaceIdParam', 'amg-workspace-id', amg.workspace.attrId);
      publishParam(this, 'AmgWorkspaceUrlParam', 'amg-workspace-url', amg.workspaceUrl);
    }
    publishParam(this, 'AdotConfigS3KeyParam', 'adot-config-s3-key', adot.s3Key);
    publishParam(this, 'AlertSnsTopicArnParam', 'alert-sns-topic-arn', alert.topic.topicArn);

    if (amg) {
      new cdk.CfnOutput(this, 'AmgWorkspaceUrl', { value: amg.workspaceUrl });
    }
    new cdk.CfnOutput(this, 'AmpWorkspaceId', { value: amp.workspace.attrWorkspaceId });
  }
}

function publishParam(scope: Construct, id: string, name: string, value: string): ssm.StringParameter {
  return new ssm.StringParameter(scope, id, {
    parameterName: `${SSM_OBS_PREFIX}/${name}`,
    stringValue: value,
  });
}
