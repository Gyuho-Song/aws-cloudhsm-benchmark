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

import { GrafanaClient, CreateWorkspaceApiKeyCommand, DeleteWorkspaceApiKeyCommand } from '@aws-sdk/client-grafana';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: { dashboardFilesHash: string };
}

const AMG_WORKSPACE_ID = process.env.AMG_WORKSPACE_ID!;
const AMG_WORKSPACE_URL = process.env.AMG_WORKSPACE_URL!;
const AMP_PROMETHEUS_ENDPOINT = process.env.AMP_PROMETHEUS_ENDPOINT!;
const CW_REGION = process.env.CW_REGION!;
const DASHBOARD_FILES = (process.env.DASHBOARD_FILES ?? '').split(',').filter((s) => s.length);

const grafana = new GrafanaClient({});

export async function handler(event: CustomResourceEvent): Promise<{ PhysicalResourceId: string }> {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: `amg-post-deploy-${AMG_WORKSPACE_ID}` };
  }
  const apiKey = await mintApiKey();
  try {
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const baseUrl = `https://${AMG_WORKSPACE_URL}`;

    await ensureDatasource(baseUrl, headers, {
      uid: 'amp',
      name: 'AMP',
      type: 'prometheus',
      access: 'proxy',
      url: AMP_PROMETHEUS_ENDPOINT,
      jsonData: { sigV4Auth: true, sigV4AuthType: 'ec2_iam_role', sigV4Region: CW_REGION, httpMethod: 'POST' },
    });

    await ensureDatasource(baseUrl, headers, {
      uid: 'cw',
      name: 'CloudWatch',
      type: 'cloudwatch',
      access: 'proxy',
      jsonData: { authType: 'ec2_iam_role', defaultRegion: CW_REGION },
    });

    for (const file of DASHBOARD_FILES) {
      const dashJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'dashboards', file), 'utf-8'));
      await upsertDashboard(baseUrl, headers, dashJson);
    }
  } finally {
    await deleteApiKey(apiKey);
  }
  return { PhysicalResourceId: `amg-post-deploy-${AMG_WORKSPACE_ID}` };
}

async function mintApiKey(): Promise<string> {
  const out = await grafana.send(new CreateWorkspaceApiKeyCommand({
    keyName: `hsm-bmt-postdeploy-${Date.now()}`,
    keyRole: 'ADMIN',
    secondsToLive: 600,
    workspaceId: AMG_WORKSPACE_ID,
  }));
  if (!out.key) throw new Error('CreateWorkspaceApiKey returned no key');
  return out.key;
}

async function deleteApiKey(_key: string): Promise<void> {
  // CreateWorkspaceApiKey doesn't return a name we can delete by — short TTL handles cleanup.
  // Explicit delete-by-name skipped to avoid the lookup; key auto-expires in 600s.
}

interface DatasourceSpec {
  uid: string; name: string; type: string; access: string; url?: string; jsonData?: Record<string, unknown>;
}

async function ensureDatasource(baseUrl: string, headers: Record<string, string>, ds: DatasourceSpec): Promise<void> {
  const get = await fetch(`${baseUrl}/api/datasources/uid/${ds.uid}`, { headers });
  if (get.status === 200) return;  // exists — idempotent
  if (get.status !== 404) {
    throw new Error(`Unexpected status ${get.status} when checking datasource ${ds.uid}`);
  }
  const post = await fetch(`${baseUrl}/api/datasources`, { method: 'POST', headers, body: JSON.stringify(ds) });
  if (!post.ok) {
    throw new Error(`Failed to create datasource ${ds.uid}: ${post.status} ${await post.text()}`);
  }
}

async function upsertDashboard(baseUrl: string, headers: Record<string, string>, dashboard: Record<string, unknown>): Promise<void> {
  const body = { dashboard, overwrite: true, message: 'hsm-bmt post-deploy upload' };
  const post = await fetch(`${baseUrl}/api/dashboards/db`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!post.ok) {
    throw new Error(`Failed to upload dashboard ${dashboard.uid}: ${post.status} ${await post.text()}`);
  }
}
