import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AmpConstructProps {
  readonly envSuffix: string;
  /** ARN of the loader instance role (from SSM in CoreStack); will be granted aps:RemoteWrite. */
  readonly loaderRoleArn: string;
  /** Expected HSMs (used to substitute ${EXPECTED_HSMS} in the rule namespace). */
  readonly expectedHsms: number;
  /** SNS topic ARN to feed to Alert Manager YAML. */
  readonly snsTopicArn: string;
  /**
   * If false, skip emitting `AWS::APS::AlertManagerDefinition` (some regions —
   * including ap-northeast-2 as of 2026-05 — have AMP workspaces but not the
   * AlertManagerDefinition CFN type yet). The alert-manager.yaml is still
   * written to S3 so the operator can `aws amp put-alert-manager-definition`
   * out-of-band. Default true.
   */
  readonly emitAlertManagerDefinition?: boolean;
}

export class AmpConstruct extends Construct {
  public readonly workspace: aps.CfnWorkspace;
  public readonly ruleGroupsNamespace: aps.CfnRuleGroupsNamespace;
  /** L1 escape hatch — undefined when emitAlertManagerDefinition === false. */
  public readonly alertManagerDefinition?: cdk.CfnResource;
  /** YAML content the operator must apply via `aws amp put-alert-manager-definition`. */
  public readonly alertManagerYaml: string;

  constructor(scope: Construct, id: string, props: AmpConstructProps) {
    super(scope, id);

    this.workspace = new aps.CfnWorkspace(this, 'Workspace', {
      alias: `hsm-bmt-${props.envSuffix}`,
      tags: [
        { key: 'hsm-bmt:role', value: 'metrics' },
        { key: 'hsm-bmt:env', value: props.envSuffix },
      ],
    });

    const rulesYaml = readAndSubstitute(
      path.join(__dirname, '..', '..', 'alerts', 'hsm-bmt-rules.yaml'),
      { EXPECTED_HSMS: String(props.expectedHsms) }
    );
    this.ruleGroupsNamespace = new aps.CfnRuleGroupsNamespace(this, 'RuleGroupsNamespace', {
      workspace: this.workspace.attrArn,
      name: 'hsm-bmt-rules',
      data: rulesYaml,
    });

    this.alertManagerYaml = readAndSubstitute(
      path.join(__dirname, '..', '..', 'assets', 'alert-manager.yaml'),
      { SNS_TOPIC_ARN: props.snsTopicArn }
    );
    if (props.emitAlertManagerDefinition !== false) {
      this.alertManagerDefinition = new cdk.CfnResource(this, 'AlertManagerDefinition', {
        type: 'AWS::APS::AlertManagerDefinition',
        properties: {
          Workspace: this.workspace.attrArn,
          Data: this.alertManagerYaml,
        },
      });
    }

    // Grant the loader EC2 role aps:RemoteWrite on this workspace
    new iam.Policy(this, 'LoaderRemoteWritePolicy', {
      roles: [iam.Role.fromRoleArn(this, 'LoaderRoleRef', props.loaderRoleArn, { mutable: false })],
      statements: [
        new iam.PolicyStatement({
          actions: ['aps:RemoteWrite'],
          resources: [this.workspace.attrArn],
        }),
      ],
    });
  }

  public get remoteWriteUrl(): string {
    return `${this.workspace.attrPrometheusEndpoint}api/v1/remote_write`;
  }
}

function readAndSubstitute(filePath: string, vars: Record<string, string>): string {
  let content = fs.readFileSync(filePath, 'utf-8');
  for (const [k, v] of Object.entries(vars)) {
    content = content.replaceAll('${' + k + '}', v);
  }
  return content;
}
