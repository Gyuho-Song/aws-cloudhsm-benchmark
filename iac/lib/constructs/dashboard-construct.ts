import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

export interface DashboardConstructProps {
  readonly amgWorkspaceId: string;
  readonly amgWorkspaceUrl: string;
  readonly ampPrometheusEndpoint: string;
  readonly cloudwatchRegion: string;
}

/**
 * Custom Resource Lambda that, on stack deploy:
 *   1. Creates AMP datasource (Prometheus, uid=amp)
 *   2. Creates CloudWatch datasource (uid=cw)
 *   3. Uploads 4 dashboard JSONs from iac/dashboards/
 * All operations are idempotent (GET → conditional POST/PUT).
 */
export class DashboardConstruct extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: DashboardConstructProps) {
    super(scope, id);

    const dashboardsDir = path.join(__dirname, '..', '..', 'dashboards');
    const dashboardFiles = fs.readdirSync(dashboardsDir).filter((f) => f.endsWith('.json'));
    // Hash CONTENT, not just filenames — when a panel/query changes inside an
    // existing dashboard JSON, the file list is unchanged but the upload
    // Lambda must re-run. Without this, AMG was stuck on old (4-panel)
    // versions while the repo had 5 panels (observed 2026-05-22).
    const dashboardContentHash = crypto.createHash('sha256');
    for (const f of dashboardFiles.sort()) {
      dashboardContentHash.update(f);
      dashboardContentHash.update(fs.readFileSync(path.join(dashboardsDir, f)));
    }
    const contentHash = dashboardContentHash.digest('hex');

    this.handler = new NodejsFunction(this, 'AmgPostDeployLambda', {
      entry: path.join(__dirname, '..', '..', 'lambda', 'amg-post-deploy', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        AMG_WORKSPACE_ID: props.amgWorkspaceId,
        AMG_WORKSPACE_URL: props.amgWorkspaceUrl,
        AMP_PROMETHEUS_ENDPOINT: props.ampPrometheusEndpoint,
        CW_REGION: props.cloudwatchRegion,
        DASHBOARD_FILES: dashboardFiles.join(','),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: [],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${inputDir}/dashboards ${outputDir}/dashboards`,
          ],
        },
      },
    });

    // Permissions to call AMG service-managed API (works under SERVICE_MANAGED auth)
    this.handler.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'grafana:DescribeWorkspace',
        'grafana:CreateWorkspaceApiKey',
        'grafana:DeleteWorkspaceApiKey',
      ],
      resources: ['*'],
    }));

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: this.handler,
    });
    new cdk.CustomResource(this, 'CustomResource', {
      serviceToken: provider.serviceToken,
      properties: {
        // Re-trigger when dashboard file list OR content changes.
        dashboardFilesHash: dashboardFiles.join(','),
        dashboardContentHash: contentHash,
      },
    });
  }
}
