import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface AdotConfigConstructProps {
  /** S3 bucket where the config is published (from CoreStack output). */
  readonly resultsBucket: s3.IBucket;
  /** ARN of the loader EC2 role to grant s3:GetObject on the config key. */
  readonly loaderRoleArn: string;
  /** AMP remote_write URL - substituted into the config at synth. */
  readonly ampRemoteWriteUrl: string;
}

/** Renders ADOT config with placeholders substituted, uploads to S3, grants Loader read. */
export class AdotConfigConstruct extends Construct {
  /** S3 key (deterministic based on config content hash). */
  public readonly s3Key: string;

  constructor(scope: Construct, id: string, props: AdotConfigConstructProps) {
    super(scope, id);

    const template = fs.readFileSync(
      path.join(__dirname, '..', '..', 'assets', 'adot-config.yaml'),
      'utf-8'
    );
    const rendered = template.replaceAll('${AMP_REMOTE_WRITE_URL}', props.ampRemoteWriteUrl);
    const hash = crypto.createHash('sha256').update(rendered).digest('hex').slice(0, 12);
    this.s3Key = `observability/adot-config-${hash}.yaml`;

    // Use CDK aws_s3_deployment to upload the rendered file; stage in the App's outdir
    // (cdk.out by default). Stack itself doesn't expose `outdir` - App does.
    const outdir = (cdk.App.of(this) as cdk.App | undefined)?.outdir ?? path.join('cdk.out');
    const stagingDir = path.join(outdir, 'adot-config-staging', hash);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, path.basename(this.s3Key)), rendered, 'utf-8');

    new s3deploy.BucketDeployment(this, 'Deployment', {
      sources: [s3deploy.Source.asset(stagingDir)],
      destinationBucket: props.resultsBucket,
      destinationKeyPrefix: 'observability',
      prune: false,
      retainOnDelete: true,
    });

    new iam.Policy(this, 'LoaderAdotConfigReadPolicy', {
      roles: [iam.Role.fromRoleArn(this, 'LoaderRoleRef', props.loaderRoleArn, { mutable: false })],
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [
            props.resultsBucket.arnForObjects('observability/adot-config-*.yaml'),
          ],
        }),
      ],
    });
  }
}
