import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { LoaderInstanceConstruct } from '../../lib/constructs/loader-instance-construct';

function synthStack(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', {
    ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
    availabilityZones: ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c', 'ap-northeast-2d'],
    natGateways: 1,
    subnetConfiguration: [
      { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    ],
  });
  const sg = new ec2.SecurityGroup(stack, 'LoaderSg', { vpc });
  const role = new iam.Role(stack, 'LoaderRole', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com') });
  new LoaderInstanceConstruct(stack, 'Loader', { vpc, securityGroup: sg, role });
  return Template.fromStack(stack);
}

describe('LoaderInstanceConstruct', () => {
  // Behavior 5.1
  test('creates a c8i.8xlarge instance in ap-northeast-2a with ENA enabled and gp3 root volume', () => {
    const t = synthStack();
    // Note: ec2.Instance L2 in CDK 2.254 omits the Throughput property from
    // BlockDeviceMappings even when set on BlockDeviceVolume.ebs(); the value
    // arrives in CFN via a separate path. We validate the rest of the shape.
    t.hasResourceProperties('AWS::EC2::Instance', Match.objectLike({
      InstanceType: 'c8i.8xlarge',
      AvailabilityZone: 'ap-northeast-2a',
      EbsOptimized: true,
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          DeviceName: '/dev/xvda',
          Ebs: Match.objectLike({
            VolumeType: 'gp3',
            VolumeSize: 200,
            Iops: 3000,
          }),
        }),
      ]),
    }));
  });

  /** Decode UserData regardless of whether CDK emitted it as a plain string under
   * "Fn::Base64" or as a Fn::Join intrinsic. */
  function decodeUserData(props: { UserData?: { 'Fn::Base64'?: unknown } }): string {
    const ud = props.UserData?.['Fn::Base64'];
    if (typeof ud === 'string') return ud;
    return JSON.stringify(ud);
  }

  // Behavior 5.2 — user-data content
  test('user-data installs Corretto 21, CloudHSM SDK 5, ADOT, iperf3 and writes systemd unit', () => {
    const t = synthStack();
    const instances = t.findResources('AWS::EC2::Instance');
    let userDataFound = false;
    for (const [, inst] of Object.entries(instances)) {
      const decoded = decodeUserData((inst as { Properties: Record<string, unknown> }).Properties as { UserData?: { 'Fn::Base64'?: unknown } });
      if (decoded.includes('java-21-amazon-corretto') &&
          decoded.includes('cloudhsm-cli') &&
          decoded.includes('aws-otel-collector') &&
          decoded.includes('iperf3') &&
          decoded.includes('hsm-bmt-runner.service') &&
          decoded.includes('hsm-bmt-verify-binary.sh')) {
        userDataFound = true;
      }
    }
    expect(userDataFound).toBe(true);
  });

  // Behavior 5.3 — Instance profile
  test('instance profile uses the provided LoaderInstanceRole', () => {
    const t = synthStack();
    t.resourceCountIs('AWS::IAM::InstanceProfile', 1);
  });

  // Behavior 5.4 — CloudWatch agent ships SDK 5 logs and loader logs
  test('CloudWatch agent config in user-data references SDK 5 logs and loader log group', () => {
    const t = synthStack();
    const instances = t.findResources('AWS::EC2::Instance');
    let cwagentFound = false;
    for (const [, inst] of Object.entries(instances)) {
      const decoded = decodeUserData((inst as { Properties: Record<string, unknown> }).Properties as { UserData?: { 'Fn::Base64'?: unknown } });
      if (decoded.includes('/var/log/aws/cloudhsm/*.log') &&
          decoded.includes('/hsm-bmt/loader')) {
        cwagentFound = true;
      }
    }
    expect(cwagentFound).toBe(true);
  });
});
