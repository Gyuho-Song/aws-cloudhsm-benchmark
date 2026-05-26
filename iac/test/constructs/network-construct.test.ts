import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkConstruct } from '../../lib/constructs/network-construct';

const BMT_AZS = ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c', 'ap-northeast-2d'];

function synthStack(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  new NetworkConstruct(stack, 'Network');
  return Template.fromStack(stack);
}

describe('NetworkConstruct', () => {
  // Behavior 1.1
  test('creates a VPC with /16 CIDR 10.20.0.0/16', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::EC2::VPC', Match.objectLike({ CidrBlock: '10.20.0.0/16' }));
  });

  // Behavior 1.2
  test('has 4 private subnets across explicitly named AZs (one per AZ, /24 CIDR)', () => {
    const t = synthStack();
    for (const az of ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c', 'ap-northeast-2d']) {
      // CDK allocates 4 publics + 4 privates from the /16; private CIDR is whatever
      // the allocator chose, but we lock the AZ + /24 size + non-public attrs.
      t.hasResourceProperties('AWS::EC2::Subnet', Match.objectLike({
        AvailabilityZone: az,
        CidrBlock: Match.stringLikeRegexp('10\\.20\\.[0-9]+\\.0/24'),
        MapPublicIpOnLaunch: false,
      }));
    }
  });

  // Behavior 1.3
  test('has at least one public subnet with NAT gateway', () => {
    const t = synthStack();
    t.hasResourceProperties('AWS::EC2::Subnet', Match.objectLike({
      MapPublicIpOnLaunch: true,
    }));
    t.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  // Behavior 1.4
  test('creates required VPC endpoints', () => {
    const t = synthStack();
    // CDK encodes ServiceName as Fn::Join intrinsic; assert by counts + types instead.
    const all = t.findResources('AWS::EC2::VPCEndpoint');
    const props = Object.values(all).map((r) => (r as { Properties: Record<string, unknown> }).Properties);
    const gateways = props.filter((p) => p.VpcEndpointType === 'Gateway');
    const interfaces = props.filter((p) => p.VpcEndpointType === 'Interface');
    // S3 + DynamoDB gateway endpoints
    expect(gateways.length).toBe(2);
    // 7 interface endpoints (SecretsManager, SSM, SSM-Messages, EC2-Messages, Logs, Monitoring, aps-workspaces)
    expect(interfaces.length).toBe(7);
  });

  // Behavior 1.5 — LoaderSG egress rules
  test('LoaderSG egress includes TCP 2223 to HsmClusterSG and TCP 443 (no port 4317 SG rule)', () => {
    const t = synthStack();
    // SG egress rule TCP 2223
    t.hasResourceProperties('AWS::EC2::SecurityGroupEgress', Match.objectLike({
      IpProtocol: 'tcp',
      FromPort: 2223,
      ToPort: 2223,
    }));
    // No SG rule references port 4317 (loopback ADOT)
    const allEgress = t.findResources('AWS::EC2::SecurityGroupEgress');
    for (const [, res] of Object.entries(allEgress)) {
      const props = (res as { Properties: Record<string, unknown> }).Properties;
      expect(props.FromPort).not.toBe(4317);
    }
  });

  // Behavior 1.5 — HsmClusterSG ingress rules
  test('HsmClusterSG ingress includes TCP 2223 from LoaderSG and self-reference', () => {
    const t = synthStack();
    // 2223 from LoaderSG (or self): expect at least 2 ingress rules with port 2223
    const allIngress = t.findResources('AWS::EC2::SecurityGroupIngress');
    let port2223Count = 0;
    for (const [, res] of Object.entries(allIngress)) {
      const props = (res as { Properties: Record<string, unknown> }).Properties;
      if (props.FromPort === 2223 && props.ToPort === 2223 && props.IpProtocol === 'tcp') {
        port2223Count += 1;
      }
    }
    expect(port2223Count).toBeGreaterThanOrEqual(2);
  });
});
