/**
 * AMG post-deploy Custom Resource Lambda.
 *
 * Creates AMP + CloudWatch datasources and uploads the 4 Part 7 dashboards.
 * Idempotent: GET-before-POST.
 *
 * Note: AMG API requires an API key. Under SERVICE_MANAGED auth this Lambda mints a
 * temporary key via grafana:CreateWorkspaceApiKey, calls the workspace HTTP API, and
 * deletes the key on completion.
 */
interface CustomResourceEvent {
    RequestType: 'Create' | 'Update' | 'Delete';
    ResourceProperties: {
        dashboardFilesHash: string;
    };
}
export declare function handler(event: CustomResourceEvent): Promise<{
    PhysicalResourceId: string;
}>;
export {};
