import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * BMT_AZS: explicit AZ list. NOT `maxAzs` - see infrastructure-design §3.1.
 * synth fails fast if account does not have all 4 AZs enabled.
 *
 * 2026-05-24 multi-cluster scale-out: AZ list is region-scoped. apne2 has
 * 4 AZs (a/b/c/d). us-west-2 has 4 AZs (a/b/c/d). The actual region letter
 * suffix is identical in both, so we derive AZs from the stack's region at
 * synth time rather than hardcoding apne2.
 */
function azsFor(region: string): string[] {
  // All BMT regions have a/b/c/d AZ letters available.
  return ['a', 'b', 'c', 'd'].map((s) => `${region}${s}`);
}
export const BMT_AZS = azsFor('ap-northeast-2');  // legacy export, single-region default

export const CLOUDHSM_SDK5_PORT = 2223;

const INTERFACE_ENDPOINT_SERVICES: ec2.InterfaceVpcEndpointAwsService[] = [
  ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
  ec2.InterfaceVpcEndpointAwsService.SSM,
  ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
  ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
  ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
  ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
  // AMP managed Prometheus workspace endpoint
  new ec2.InterfaceVpcEndpointAwsService('aps-workspaces'),
];

export class NetworkConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly loaderSg: ec2.SecurityGroup;
  public readonly hsmClusterSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Resolve AZs from the parent stack's region at synth time so the same
    // construct can be deployed in apne2 or usw2 without code changes.
    const stackRegion = cdk.Stack.of(this).region;
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      availabilityZones: azsFor(stackRegion),
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    this.privateSubnets = this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets;

    // Gateway endpoints
    this.vpc.addGatewayEndpoint('S3Gateway', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    this.vpc.addGatewayEndpoint('DynamoDbGateway', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });

    // Interface endpoints
    for (const svc of INTERFACE_ENDPOINT_SERVICES) {
      this.vpc.addInterfaceEndpoint(`Iface-${svc.shortName}`, {
        service: svc,
        privateDnsEnabled: true,
      });
    }

    // HsmClusterSG: inbound TCP 2223 from LoaderSG + self-reference
    this.hsmClusterSg = new ec2.SecurityGroup(this, 'HsmClusterSg', {
      vpc: this.vpc,
      description: 'CloudHSM cluster ENIs - accepts SDK 5 mTLS on TCP 2223',
      allowAllOutbound: false,
    });
    this.hsmClusterSg.addIngressRule(this.hsmClusterSg, ec2.Port.tcp(CLOUDHSM_SDK5_PORT), 'HSM cluster sync (self)');

    // LoaderSG: egress TCP 2223 to HsmClusterSG + TCP 443 to AWS endpoints
    this.loaderSg = new ec2.SecurityGroup(this, 'LoaderSg', {
      vpc: this.vpc,
      description: 'BMT loader EC2 - outbound to CloudHSM and AWS endpoints',
      allowAllOutbound: false,
    });
    this.loaderSg.addEgressRule(this.hsmClusterSg, ec2.Port.tcp(CLOUDHSM_SDK5_PORT), 'CloudHSM SDK 5 mTLS');
    this.loaderSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'AWS endpoints (S3, SSM, SecretsManager, AMP, AMG, DynamoDB, etc.)');

    // Now that LoaderSG exists, allow it inbound to HSM cluster
    this.hsmClusterSg.addIngressRule(this.loaderSg, ec2.Port.tcp(CLOUDHSM_SDK5_PORT), 'Loader to HSM SDK 5');
  }
}
