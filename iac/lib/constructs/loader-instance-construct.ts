import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LoaderInstanceConstructProps {
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
  readonly role: iam.IRole;
  readonly instanceType?: ec2.InstanceType;
}

export class LoaderInstanceConstruct extends Construct {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: LoaderInstanceConstructProps) {
    super(scope, id);

    const userDataScript = fs.readFileSync(
      path.join(__dirname, '..', '..', 'assets', 'loader-bootstrap.sh'),
      'utf-8'
    );

    const userData = ec2.UserData.custom(userDataScript);

    // Pin to <region>a — first AZ. Region resolved from the parent stack so
    // the same construct works in apne2 / usw2 without code changes.
    const region = cdk.Stack.of(this).region;
    const az1 = `${region}a`;
    const az1Subnet = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      availabilityZones: [az1],
    }).subnets[0];

    this.instance = new ec2.Instance(this, 'LoaderEc2', {
      vpc: props.vpc,
      vpcSubnets: { subnets: [az1Subnet] },
      availabilityZone: az1,
      instanceType: props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.C8I, ec2.InstanceSize.XLARGE8),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 }),
      securityGroup: props.securityGroup,
      role: props.role,
      userData,
      ebsOptimized: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(200, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            iops: 3000,
            throughput: 125,
            encrypted: true,
          }),
        },
      ],
    });
  }
}
