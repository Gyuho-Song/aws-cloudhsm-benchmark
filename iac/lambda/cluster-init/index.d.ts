/**
 * BMT Cluster + HSM lifecycle Custom Resource Lambda — async pattern.
 *
 * AWS::CloudHSMV2::{Cluster,Hsm} are NOT valid CloudFormation resource types
 * (verified 2026-05-16 via cloudformation:DescribeType → TypeNotFoundException).
 * CloudHSMV2 resources have to be created via the SDK. We do that here from a
 * pair of handlers (onEvent + isComplete) so the entire flow can take >15 min:
 *
 *   onEvent:
 *     - On Create/Update: ensure cluster exists (CreateCluster if not), kick off
 *       HSM creation in parallel with the existing fleet, generate ephemeral CA
 *       (PutSecretValue), return PhysicalResourceId = ClusterId.
 *     - On Delete: schedule HSM deletes; isComplete waits for them all to vanish,
 *       then DeleteCluster.
 *
 *   isComplete (CFN polls every queryInterval):
 *     - For Create/Update: returns IsComplete=true once cluster.State == ACTIVE
 *       AND the requested number of HSMs are all ACTIVE. If cluster is
 *       UNINITIALIZED with a CSR, signs and InitializeCluster, then keeps polling.
 *     - For Delete: returns IsComplete=true once cluster is gone.
 *
 * Each HSM creation is launched asynchronously; the SDK serializes through CloudHSM
 * itself, so isComplete just polls until the desired fleet matches the actual fleet.
 */
interface SlotSpec {
    logicalId: string;
    az: string;
}
interface CustomResourceEvent {
    RequestType: 'Create' | 'Update' | 'Delete';
    PhysicalResourceId?: string;
    ResourceProperties: {
        HsmType: string;
        SubnetIds: string[];
        Slots: SlotSpec[];
        CaSecretArn: string;
    };
}
export declare function handler(event: CustomResourceEvent): Promise<{
    PhysicalResourceId: string;
    Data?: Record<string, string>;
}>;
export declare function isComplete(event: CustomResourceEvent): Promise<{
    IsComplete: boolean;
    Data?: Record<string, string>;
}>;
export {};
