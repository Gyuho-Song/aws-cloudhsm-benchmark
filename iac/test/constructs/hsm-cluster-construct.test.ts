import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { HsmClusterConstruct, enabledSlotsFor, HSM_SLOTS } from '../../lib/constructs/hsm-cluster-construct';

function synthStackWithCount(desiredHsmCount: number): { template: Template; stack: cdk.Stack } {
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
  const sg = new ec2.SecurityGroup(stack, 'HsmSg', { vpc });
  const caSecret = new secretsmanager.Secret(stack, 'CaSecret', { secretName: 'hsm-bmt/ca-private-key' });
  new HsmClusterConstruct(stack, 'HsmCluster', {
    vpc,
    privateSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets,
    hsmClusterSecurityGroup: sg,
    caSecret,
    desiredHsmCount,
  });
  return { template: Template.fromStack(stack), stack };
}

describe('HsmClusterConstruct', () => {
  test('publishes only SSM parameters; CloudHSM lifecycle is out-of-band', () => {
    const { template } = synthStackWithCount(6);
    template.resourceCountIs('AWS::CloudHSMV2::Cluster', 0);
    template.resourceCountIs('AWS::CloudHSMV2::Hsm', 0);
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('emits hsm-slots SSM parameter with the desiredHsmCount trajectory', () => {
    const { template } = synthStackWithCount(6);
    template.hasResourceProperties('AWS::SSM::Parameter', Match.objectLike({
      Name: '/hsm-bmt/core/hsm-slots',
      Value: Match.serializedJson([
        { logicalId: 'HsmAz1Slot1', az: 'ap-northeast-2a' },
        { logicalId: 'HsmAz2Slot1', az: 'ap-northeast-2b' },
        { logicalId: 'HsmAz3Slot1', az: 'ap-northeast-2c' },
        { logicalId: 'HsmAz4Slot1', az: 'ap-northeast-2d' },
        { logicalId: 'HsmAz1Slot2', az: 'ap-northeast-2a' },
        { logicalId: 'HsmAz2Slot2', az: 'ap-northeast-2b' },
      ]),
    }));
    template.hasResourceProperties('AWS::SSM::Parameter', Match.objectLike({
      Name: '/hsm-bmt/core/desired-hsm-count',
      Value: '6',
    }));
  });

  test.each([
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 5],
    [6, 6],
  ])('desiredHsmCount=%i emits %i slots in /hsm-bmt/core/hsm-slots', (desired, expected) => {
    const { template } = synthStackWithCount(desired);
    const params = template.findResources('AWS::SSM::Parameter', {
      Properties: { Name: '/hsm-bmt/core/hsm-slots' },
    });
    const entry = Object.values(params)[0] as { Properties: { Value: string } };
    const slots = JSON.parse(entry.Properties.Value) as Array<{ logicalId: string; az: string }>;
    expect(slots.length).toBe(expected);
  });

  test('clusterIdParameterName is the well-known SSM path', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'ap-northeast-2' } });
    const vpc = new ec2.Vpc(stack, 'V', {
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      availabilityZones: ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c', 'ap-northeast-2d'],
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });
    const sg = new ec2.SecurityGroup(stack, 'Sg', { vpc });
    const caSecret = new secretsmanager.Secret(stack, 'C', { secretName: 'hsm-bmt/ca-private-key' });
    const hsm = new HsmClusterConstruct(stack, 'Hsm', {
      vpc,
      privateSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets,
      hsmClusterSecurityGroup: sg,
      caSecret,
      desiredHsmCount: 6,
    });
    expect(hsm.clusterIdParameterName).toBe('/hsm-bmt/core/cluster-id');
    expect(hsm.clusterId).toBe('pending:/hsm-bmt/core/cluster-id');
  });

  test('enabledSlotsFor helper matches Q5 trajectory', () => {
    expect(enabledSlotsFor(6).map((s) => s.logicalId)).toEqual(['HsmAz1Slot1', 'HsmAz2Slot1', 'HsmAz3Slot1', 'HsmAz4Slot1', 'HsmAz1Slot2', 'HsmAz2Slot2']);
    expect(enabledSlotsFor(5).map((s) => s.logicalId)).toEqual(['HsmAz1Slot1', 'HsmAz2Slot1', 'HsmAz3Slot1', 'HsmAz4Slot1', 'HsmAz1Slot2']);
    expect(enabledSlotsFor(4).map((s) => s.logicalId)).toEqual(['HsmAz1Slot1', 'HsmAz2Slot1', 'HsmAz3Slot1', 'HsmAz4Slot1']);
    expect(enabledSlotsFor(3).map((s) => s.logicalId)).toEqual(['HsmAz1Slot1', 'HsmAz2Slot1', 'HsmAz3Slot1']);
    expect(enabledSlotsFor(2).map((s) => s.logicalId)).toEqual(['HsmAz1Slot1', 'HsmAz2Slot1']);
  });

  test('HSM_SLOTS constant has 6 entries with fixed order', () => {
    expect(HSM_SLOTS).toHaveLength(6);
    expect(HSM_SLOTS[0]).toEqual({ logicalId: 'HsmAz1Slot1', az: 'ap-northeast-2a' });
    expect(HSM_SLOTS[5]).toEqual({ logicalId: 'HsmAz2Slot2', az: 'ap-northeast-2b' });
  });
});
