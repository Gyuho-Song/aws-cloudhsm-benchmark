import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface FrontendConstructProps {
  readonly envSuffix: string;
  /** Source directory for the static export (defaults to web/out). Optional so the
   * construct synthesizes even before the Next.js build step has run. */
  readonly siteSourcePath?: string;
}

export class FrontendConstruct extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cf.Distribution;

  constructor(scope: Construct, id: string, props: FrontendConstructProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `hsm-bmt-web-${props.envSuffix}-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Viewer-request CF Function: rewrites /path -> /path/index.html so
    // Next.js static-export sub-paths (/monitor, /runs/new, ...) resolve
    // correctly under OAC + BlockPublicAccess. Unknown paths still fall
    // through and trigger the 403/404 -> /index.html error response so the
    // SPA can handle /callback?code=... and other client-side routes.
    const indexRewrite = new cf.Function(this, 'IndexRewrite', {
      code: cf.FunctionCode.fromInline(`
        function handler(event) {
          var req = event.request;
          var uri = req.uri;

          // Map /runs/<id>/(live|dashboard|results|report) to the
          // placeholder bundle, then let the SPA pick up the real id from
          // window.location at runtime via useRunIdFromUrl().
          var dyn = uri.match(/^\\/runs\\/([^/]+)\\/(live|dashboard|results|report)\\/?$/);
          if (dyn && dyn[1] !== 'placeholder' && dyn[1] !== 'new') {
            req.uri = '/runs/placeholder/' + dyn[2] + '/index.html';
            return req;
          }

          // Skip files (anything with a dot in the last segment)
          var last = uri.split('/').pop();
          if (last && last.indexOf('.') !== -1) return req;
          if (uri.endsWith('/')) {
            req.uri = uri + 'index.html';
          } else {
            req.uri = uri + '/index.html';
          }
          return req;
        }
      `),
      runtime: cf.FunctionRuntime.JS_2_0,
      comment: 'Rewrite /path to /path/index.html + map dynamic /runs/<id>/* to placeholder bundle',
    });

    this.distribution = new cf.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{
          function: indexRewrite,
          eventType: cf.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        // Unknown paths fall through to root /index.html so the SPA's client
        // router can handle them (e.g., /callback?code=... from Cognito).
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(0) },
      ],
      priceClass: cf.PriceClass.PRICE_CLASS_200,
      comment: 'CloudHSM BMT web console',
    });

    // Optional deployment when web/out exists
    const sourcePath = props.siteSourcePath
      ?? path.join(__dirname, '..', '..', '..', 'web', 'out');
    if (fs.existsSync(sourcePath)) {
      new s3deploy.BucketDeployment(this, 'Deployment', {
        sources: [s3deploy.Source.asset(sourcePath)],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        distributionPaths: ['/*'],
      });
    }
  }
}
