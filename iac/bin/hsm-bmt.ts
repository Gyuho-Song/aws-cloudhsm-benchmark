#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CoreStack } from '../lib/core-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

// 2026-05-24: region 을 context 로 분리 — us-west-2 multi-cluster scale-out
// 시나리오 (cs=2 × 3 cluster) 를 위한 사전 작업. ap-northeast-2 default 보존.
// Per-region stack name suffix (envSuffix) 로 동일 account 에 양 region stack
// 공존 가능. Web/Observability 는 region 별 deploy 여부를 분리해서 controlling
// — us-west-2 는 CoreStack + AMP only deploy (UI/AMG 는 apne2 통합).
const region = (app.node.tryGetContext('region') as string) ?? 'ap-northeast-2';
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

const envSuffix = (app.node.tryGetContext('envSuffix') as string) ?? 'dev';
const desiredHsmCount = (app.node.tryGetContext('desiredHsmCount') as number) ?? 6;
// Multi-cluster scale-out: cluster 갯수 (default 1, 기존 single-cluster 동작 보존)
// 와 cluster 당 HSM 수 (default = desiredHsmCount, 기존 cs=6 single cluster 보존)
const clusterCount = (app.node.tryGetContext('clusterCount') as number) ?? 1;
const hsmsPerCluster =
  (app.node.tryGetContext('hsmsPerCluster') as number) ??
  (clusterCount > 1 ? 2 : desiredHsmCount);
const deployObservability = app.node.tryGetContext('deployObservability') !== false;
const deployWeb = app.node.tryGetContext('deployWeb') !== false;
// us-west-2 환경에서는 AMG 안 띄움 — apne2 의 단일 AMG 가 cross-region datasource
// 로 양쪽 AMP 를 query (AMP-adding-AWS-config.html 공식 지원).
const deployAmg = app.node.tryGetContext('deployAmg') !== false;

const core = new CoreStack(app, 'CoreStack', {
  env,
  description: 'CloudHSM CloudHSM BMT — Unit 1 Infrastructure (network, IAM, CloudHSM, EC2, S3, secrets, repository)',
});

if (deployObservability) {
  const operatorEmailsCtx = app.node.tryGetContext('operatorEmails') as string[] | string | undefined;
  const operatorEmails = Array.isArray(operatorEmailsCtx)
    ? operatorEmailsCtx
    : typeof operatorEmailsCtx === 'string' && operatorEmailsCtx.length > 0
      ? operatorEmailsCtx.split(',').map((e) => e.trim()).filter((e) => e.length > 0)
      : [];

  const obs = new ObservabilityStack(app, 'ObservabilityStack', {
    env,
    envSuffix,
    expectedHsms: clusterCount > 1 ? clusterCount * hsmsPerCluster : desiredHsmCount,
    operatorEmails,
    deployAmg,
    description: 'CloudHSM CloudHSM BMT — Unit 3 Observability (AMP + AMG + ADOT + dashboards + alarms)',
  });
  obs.addDependency(core);
}

if (deployWeb) {
  // U-CH-1 Stage C swap: pass --context enableCustomAuthorizer=true to flip
  // API Gateway from built-in Cognito authorizer to our custom REQUEST
  // authorizer Lambda. Default false keeps the safe pre-handover state.
  const enableCustomAuthorizer = String(app.node.tryGetContext('enableCustomAuthorizer') ?? 'false') === 'true';
  // Multi-region loader instances: scenario 카드의 region 값으로 어느 region 의
  // loader EC2 에 SSM SendCommand 보낼지 결정. apne2 의 lambda IAM 에 양 region
  // 의 EC2 ARN + SSM document ARN 권한 추가 (api-construct.ts 가 처리).
  const loaderRegionsCtx = app.node.tryGetContext('loaderRegions') as string | undefined;
  const loaderRegions = loaderRegionsCtx && loaderRegionsCtx.length > 0
    ? loaderRegionsCtx.split(',').map((r) => r.trim()).filter((r) => r.length > 0)
    : [region];
  const web = new WebStack(app, 'WebStack', {
    env,
    envSuffix,
    enableCustomAuthorizer,
    loaderRegions,
    description: 'CloudHSM CloudHSM BMT — Unit 5 Web Console (Cognito + DynamoDB + API Gateway + Lambda + CloudFront/S3)',
  });
  web.addDependency(core);
}
