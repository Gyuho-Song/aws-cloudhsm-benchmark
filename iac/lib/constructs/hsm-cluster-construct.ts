import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * CloudHSM cluster + HSM lifecycle is OUT OF CDK SCOPE.
 *
 * Why: AWS::CloudHSMV2::{Cluster,Hsm} aren't valid CFN resource types and a
 * Lambda Custom Resource that walks the SDK takes longer than the CFN custom
 * resource framework's ~2-hour ceiling for 6 HSMs (≈ 25 min × 6 sequential creates).
 *
 * The operator runs `scripts/cluster-create.sh` after `cdk deploy CoreStack`
 * (see iac/scripts/) — that script reads the CDK-published SSM parameters
 * (subnet-ids, ca-private-key secret ARN, etc.), calls cloudhsmv2:CreateCluster
 * + repeated CreateHsm + InitializeCluster, then writes the resulting cluster ID
 * back to SSM at /hsm-bmt/core/cluster-id for downstream stacks (Loader, Web,
 * Observability) to consume.
 *
 * This construct's only job now is to create placeholder SSM parameters so
 * dependent stacks can `valueForStringParameter` without erroring at synth,
 * and to keep the slot allocation table close to where the lifecycle script
 * reads it.
 *
 * 2026-05-24 multi-cluster scale-out (us-west-2): clusterCount > 1 시 cluster
 * 갯수 만큼 별도 SSM key (`cluster-id-1`, `cluster-id-2`, ...) 가 생성되어야
 * 함. backwards-compat: clusterCount=1 (default) 에선 기존 단일 path
 * `/hsm-bmt/core/cluster-id` 만 사용. clusterCount > 1 시 첫 cluster 의 ID 가
 * `cluster-id` AND `cluster-id-1` 양쪽으로 alias (downstream 의 단일 path
 * 가정 코드가 그대로 동작하도록).
 */
export interface HsmSlot {
  readonly logicalId: string;
  readonly az: string;
}

/**
 * Slot allocation for a single cluster. AZ list is region-agnostic logical
 * 1..4; the operator script maps logicalAzIndex → actual AZ at runtime.
 */
const HSM_SLOTS_SINGLE_CLUSTER: readonly HsmSlot[] = [
  { logicalId: 'HsmAz1Slot1', az: 'logical-az-1' },
  { logicalId: 'HsmAz2Slot1', az: 'logical-az-2' },
  { logicalId: 'HsmAz3Slot1', az: 'logical-az-3' },
  { logicalId: 'HsmAz4Slot1', az: 'logical-az-4' },
  { logicalId: 'HsmAz1Slot2', az: 'logical-az-1' },
  { logicalId: 'HsmAz2Slot2', az: 'logical-az-2' },
] as const;

/**
 * Backwards-compat: single-cluster slot list. New callers should use
 * `slotsForCluster(clusterIdx, hsmsPerCluster)`.
 */
export const HSM_SLOTS: readonly HsmSlot[] = HSM_SLOTS_SINGLE_CLUSTER;

export function enabledSlotsFor(desiredHsmCount: number): readonly HsmSlot[] {
  if (desiredHsmCount < 2 || desiredHsmCount > 6) {
    throw new Error(`desiredHsmCount must be in [2, 6]; got ${desiredHsmCount}`);
  }
  return HSM_SLOTS_SINGLE_CLUSTER.slice(0, desiredHsmCount);
}

/**
 * Per-cluster slot allocation for the multi-cluster path. clusterIdx is
 * 1-based (matches `cluster-id-1`, `cluster-id-2`, ... SSM keys).
 * hsmsPerCluster is 2 (cs=2 sweet spot for the multi-cluster scale-out
 * scenario). Slots are distributed across logical AZs 1-2 (cs=2 = 2 AZ HA).
 */
export function slotsForCluster(clusterIdx: number, hsmsPerCluster: number): readonly HsmSlot[] {
  if (hsmsPerCluster < 2 || hsmsPerCluster > 4) {
    throw new Error(`hsmsPerCluster must be in [2, 4]; got ${hsmsPerCluster}`);
  }
  const slots: HsmSlot[] = [];
  for (let i = 0; i < hsmsPerCluster; i++) {
    const azIdx = (i % 2) + 1; // alternate logical-az-1, logical-az-2
    slots.push({
      logicalId: `Hsm-C${clusterIdx}-Az${azIdx}-Slot${Math.floor(i / 2) + 1}`,
      az: `logical-az-${azIdx}`,
    });
  }
  return slots;
}

export interface HsmClusterConstructProps {
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly hsmClusterSecurityGroup: ec2.ISecurityGroup;
  readonly caSecret: secretsmanager.ISecret;
  /**
   * Total HSM count (single-cluster path). Used when clusterCount=1.
   * For multi-cluster path, hsmsPerCluster is used instead.
   */
  readonly desiredHsmCount: number;
  /**
   * Number of CloudHSM clusters to provision. Default 1 (existing single-
   * cluster behavior). When > 1, the operator script creates N clusters and
   * publishes their IDs to /hsm-bmt/core/cluster-id-1 ... /cluster-id-N.
   * The first cluster's ID is also aliased to /hsm-bmt/core/cluster-id for
   * backwards-compat with single-cluster downstream code.
   */
  readonly clusterCount?: number;
  /**
   * HSMs per cluster. Default = desiredHsmCount when clusterCount=1; default 2
   * when clusterCount > 1 (cs=2 multi-cluster sweet spot per
   * v3-multi-cluster-uswest2-plan).
   */
  readonly hsmsPerCluster?: number;
}

export class HsmClusterConstruct extends Construct {
  /** Cluster ID — placeholder until operator runs cluster-create.sh and writes the real ID to SSM. */
  public readonly clusterId: string;
  /** SSM parameter name where the operator script writes the actual cluster ID (single-cluster path). */
  public readonly clusterIdParameterName: string = '/hsm-bmt/core/cluster-id';
  /** Number of clusters this stack expects (for downstream multi-slot wiring). */
  public readonly clusterCount: number;
  /** HSMs per cluster (for downstream wiring). */
  public readonly hsmsPerCluster: number;

  constructor(scope: Construct, id: string, props: HsmClusterConstructProps) {
    super(scope, id);

    const subnetIds = props.privateSubnets.map((s) => s.subnetId);
    if (subnetIds.length !== 4) {
      throw new Error(`HsmClusterConstruct expects 4 private subnets, got ${subnetIds.length}`);
    }

    const clusterCount = props.clusterCount ?? 1;
    if (clusterCount < 1 || clusterCount > 10) {
      throw new Error(`clusterCount must be in [1, 10]; got ${clusterCount}`);
    }
    const hsmsPerCluster = props.hsmsPerCluster
      ?? (clusterCount > 1 ? 2 : props.desiredHsmCount);
    this.clusterCount = clusterCount;
    this.hsmsPerCluster = hsmsPerCluster;

    if (clusterCount === 1) {
      // Single-cluster (existing) path — preserve original SSM keys verbatim.
      new ssm.StringParameter(this, 'SlotsParam', {
        parameterName: '/hsm-bmt/core/hsm-slots',
        stringValue: JSON.stringify(enabledSlotsFor(props.desiredHsmCount)),
        description: 'HSM slot allocation (logicalId + az) for the operator cluster-create.sh script',
      });
      new ssm.StringParameter(this, 'DesiredHsmCountParam', {
        parameterName: '/hsm-bmt/core/desired-hsm-count',
        stringValue: String(props.desiredHsmCount),
      });
    } else {
      // Multi-cluster path — publish per-cluster slot config + aggregate
      // counters. The operator script (cluster-create.sh) iterates
      // clusterCount and creates each cluster with hsmsPerCluster HSMs.
      for (let i = 1; i <= clusterCount; i++) {
        new ssm.StringParameter(this, `SlotsParamC${i}`, {
          parameterName: `/hsm-bmt/core/hsm-slots-${i}`,
          stringValue: JSON.stringify(slotsForCluster(i, hsmsPerCluster)),
          description: `HSM slot allocation for cluster #${i} (multi-cluster scale-out)`,
        });
      }
      new ssm.StringParameter(this, 'ClusterCountParam', {
        parameterName: '/hsm-bmt/core/cluster-count',
        stringValue: String(clusterCount),
        description: 'Number of CloudHSM clusters in this stack (multi-cluster scale-out)',
      });
      new ssm.StringParameter(this, 'HsmsPerClusterParam', {
        parameterName: '/hsm-bmt/core/hsms-per-cluster',
        stringValue: String(hsmsPerCluster),
      });
      // Backwards-compat: also publish desired-hsm-count = total. Existing
      // observability code reads this for ExpectedHsmCount alarm threshold;
      // keeping it = total preserves the alarm semantics under multi-cluster.
      new ssm.StringParameter(this, 'DesiredHsmCountParamMc', {
        parameterName: '/hsm-bmt/core/desired-hsm-count',
        stringValue: String(clusterCount * hsmsPerCluster),
      });
    }

    // The cluster ID is written by the operator script *after* CFN deploy.
    // We expose the parameter name; downstream code does
    // valueForStringParameter('/hsm-bmt/core/cluster-id') at synth-time.
    // Multi-cluster: the script ALSO writes /hsm-bmt/core/cluster-id-1..N
    // and aliases the first to /hsm-bmt/core/cluster-id.
    this.clusterId = `pending:${this.clusterIdParameterName}`;
  }
}
