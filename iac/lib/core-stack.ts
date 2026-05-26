import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NetworkConstruct } from './constructs/network-construct';
import { IamConstruct } from './constructs/iam-construct';
import { CryptoConstruct } from './constructs/crypto-construct';
import { HsmClusterConstruct } from './constructs/hsm-cluster-construct';
import { LoaderInstanceConstruct } from './constructs/loader-instance-construct';
import { StorageConstruct } from './constructs/storage-construct';
import { RepositoryConstruct } from './constructs/repository-construct';

const SSM_PREFIX = '/hsm-bmt/core';

function publishParam(scope: Construct, id: string, name: string, value: string): ssm.StringParameter {
  return new ssm.StringParameter(scope, id, {
    parameterName: `${SSM_PREFIX}/${name}`,
    stringValue: value,
  });
}

export class CoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Read context - see cdk.json defaults
    const desiredHsmCount = this.node.tryGetContext('desiredHsmCount') ?? 6;
    // 2026-05-24 multi-cluster scale-out: clusterCount/hsmsPerCluster context.
    // clusterCount=1 (default) preserves the existing single-cluster cs=6 path.
    const clusterCount: number = this.node.tryGetContext('clusterCount') ?? 1;
    const hsmsPerCluster: number | undefined = this.node.tryGetContext('hsmsPerCluster') ?? undefined;
    const sdsAccountId: string = this.node.tryGetContext('sdsAccountId') ?? '000000000000';
    const sdsExternalId: string = this.node.tryGetContext('sdsExternalId') ?? 'hsm-bmt-handoff';
    const repositoryProvider: 'codecommit' | 'github' = this.node.tryGetContext('repositoryProvider') ?? 'codecommit';

    const network = new NetworkConstruct(this, 'Network');
    const storage = new StorageConstruct(this, 'Storage');
    const crypto = new CryptoConstruct(this, 'Crypto');

    const iamCtor = new IamConstruct(this, 'Iam', {
      sdsAccountId,
      sdsExternalId,
      resultsBucketArnPattern: storage.resultsBucket.bucketArn,
    });
    storage.resultsBucket.grantRead(iamCtor.operatorRole);

    const hsm = new HsmClusterConstruct(this, 'HsmCluster', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      hsmClusterSecurityGroup: network.hsmClusterSg,
      caSecret: crypto.caSecret,
      desiredHsmCount,
      clusterCount,
      hsmsPerCluster,
    });

    const loader = new LoaderInstanceConstruct(this, 'Loader', {
      vpc: network.vpc,
      securityGroup: network.loaderSg,
      role: iamCtor.loaderInstanceRole,
    });
    loader.node.addDependency(hsm);

    const repository = new RepositoryConstruct(this, 'Repository', {
      provider: repositoryProvider,
      operatorRole: iamCtor.operatorRole,
    });

    // SSM Parameter Store cross-stack outputs (consumed by Units 2/3/5)
    publishParam(this, 'VpcIdParam', 'vpc-id', network.vpc.vpcId);
    publishParam(this, 'SubnetIdsParam', 'subnet-ids-csv', network.privateSubnets.map((s) => s.subnetId).join(','));
    publishParam(this, 'LoaderSgIdParam', 'loader-sg-id', network.loaderSg.securityGroupId);
    publishParam(this, 'LoaderRoleArnParam', 'loader-role-arn', iamCtor.loaderInstanceRole.roleArn);
    publishParam(this, 'LoaderInstanceIdParam', 'loader-instance-id', loader.instance.instanceId);
    // /hsm-bmt/core/cluster-id is written by scripts/cluster-create.sh after this
    // stack deploys; CDK does NOT publish it (a placeholder would clobber the
    // real value on every redeploy and break downstream stacks at synth).
    publishParam(this, 'ClusterSgIdParam', 'cluster-sg-id', network.hsmClusterSg.securityGroupId);
    publishParam(this, 'S3BucketNameParam', 's3-bucket-name', storage.resultsBucket.bucketName);
    publishParam(this, 'CoPasswordSecretArnParam', 'co-password-secret-arn', crypto.coPasswordSecret.secretArn);
    publishParam(this, 'CuPasswordSecretArnParam', 'cu-password-secret-arn', crypto.cuPasswordSecret.secretArn);

    // Stack outputs (also useful for other tooling)
    new cdk.CfnOutput(this, 'ResultsBucketName', { value: storage.resultsBucket.bucketName });
    new cdk.CfnOutput(this, 'ClusterIdParameter', { value: hsm.clusterIdParameterName, description: 'SSM path where cluster-create.sh writes the real CloudHSM cluster ID' });
    new cdk.CfnOutput(this, 'LoaderInstanceId', { value: loader.instance.instanceId });
    if (repository.codecommitRepository) {
      new cdk.CfnOutput(this, 'CodeCommitRepoUrl', { value: repository.codecommitRepository.repositoryCloneUrlHttp });
    }
  }
}
