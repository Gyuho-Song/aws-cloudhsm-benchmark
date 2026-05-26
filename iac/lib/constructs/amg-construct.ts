import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface AmgConstructProps {
  readonly envSuffix: string;
}

export class AmgConstruct extends Construct {
  public readonly workspace: grafana.CfnWorkspace;
  public readonly serviceRole: iam.Role;

  constructor(scope: Construct, id: string, props: AmgConstructProps) {
    super(scope, id);

    this.serviceRole = new iam.Role(this, 'AmgServiceRole', {
      assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com'),
      description: 'Amazon Managed Grafana workspace service role - AMP query + CloudWatch read',
    });
    this.serviceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'aps:QueryMetrics',
        'aps:GetSeries',
        'aps:GetLabels',
        'aps:GetMetricMetadata',
      ],
      resources: ['*'],
    }));
    this.serviceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cloudwatch:DescribeAlarmsForMetric',
        'cloudwatch:DescribeAlarmHistory',
        'cloudwatch:DescribeAlarms',
        'cloudwatch:ListMetrics',
        'cloudwatch:GetMetricData',
        'cloudwatch:GetInsightRuleReport',
        'logs:DescribeLogGroups',
        'logs:GetLogGroupFields',
        'logs:StartQuery',
        'logs:StopQuery',
        'logs:GetQueryResults',
        'logs:GetLogEvents',
      ],
      resources: ['*'],
    }));

    this.workspace = new grafana.CfnWorkspace(this, 'Workspace', {
      name: `hsm-bmt-${props.envSuffix}`,
      accountAccessType: 'CURRENT_ACCOUNT',
      // AWS IAM Identity Center (formerly AWS SSO) is the BMT auth path.
      // Cognito User Pool (Unit 5) is the *web console* operator IdP; AMG is reached
      // via IAM Identity Center because Cognito User Pool is a Service Provider, not
      // a SAML Identity Provider. Operators sign in to AMG separately through the
      // Identity Center login portal.
      authenticationProviders: ['AWS_SSO'],
      permissionType: 'SERVICE_MANAGED',
      dataSources: ['PROMETHEUS', 'CLOUDWATCH'],
      notificationDestinations: ['SNS'],
      roleArn: this.serviceRole.roleArn,
    });
  }

  public get workspaceUrl(): string {
    const stack = cdk.Stack.of(this);
    return `${this.workspace.attrId}.grafana-workspace.${stack.region}.amazonaws.com`;
  }
}
