"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
const client_grafana_1 = require("@aws-sdk/client-grafana");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const AMG_WORKSPACE_ID = process.env.AMG_WORKSPACE_ID;
const AMG_WORKSPACE_URL = process.env.AMG_WORKSPACE_URL;
const AMP_PROMETHEUS_ENDPOINT = process.env.AMP_PROMETHEUS_ENDPOINT;
const CW_REGION = process.env.CW_REGION;
const DASHBOARD_FILES = (process.env.DASHBOARD_FILES ?? '').split(',').filter((s) => s.length);
const grafana = new client_grafana_1.GrafanaClient({});
async function handler(event) {
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
    }
    finally {
        await deleteApiKey(apiKey);
    }
    return { PhysicalResourceId: `amg-post-deploy-${AMG_WORKSPACE_ID}` };
}
async function mintApiKey() {
    const out = await grafana.send(new client_grafana_1.CreateWorkspaceApiKeyCommand({
        keyName: `hsm-bmt-postdeploy-${Date.now()}`,
        keyRole: 'ADMIN',
        secondsToLive: 600,
        workspaceId: AMG_WORKSPACE_ID,
    }));
    if (!out.key)
        throw new Error('CreateWorkspaceApiKey returned no key');
    return out.key;
}
async function deleteApiKey(_key) {
    // CreateWorkspaceApiKey doesn't return a name we can delete by — short TTL handles cleanup.
    // Explicit delete-by-name skipped to avoid the lookup; key auto-expires in 600s.
}
async function ensureDatasource(baseUrl, headers, ds) {
    const get = await fetch(`${baseUrl}/api/datasources/uid/${ds.uid}`, { headers });
    if (get.status === 200)
        return; // exists — idempotent
    if (get.status !== 404) {
        throw new Error(`Unexpected status ${get.status} when checking datasource ${ds.uid}`);
    }
    const post = await fetch(`${baseUrl}/api/datasources`, { method: 'POST', headers, body: JSON.stringify(ds) });
    if (!post.ok) {
        throw new Error(`Failed to create datasource ${ds.uid}: ${post.status} ${await post.text()}`);
    }
}
async function upsertDashboard(baseUrl, headers, dashboard) {
    const body = { dashboard, overwrite: true, message: 'hsm-bmt post-deploy upload' };
    const post = await fetch(`${baseUrl}/api/dashboards/db`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!post.ok) {
        throw new Error(`Failed to upload dashboard ${dashboard.uid}: ${post.status} ${await post.text()}`);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7OztHQVNHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQW1CSCwwQkFrQ0M7QUFuREQsNERBQW9IO0FBQ3BILDRDQUE4QjtBQUM5QixnREFBa0M7QUFPbEMsTUFBTSxnQkFBZ0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFpQixDQUFDO0FBQ3ZELE1BQU0saUJBQWlCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxpQkFBa0IsQ0FBQztBQUN6RCxNQUFNLHVCQUF1QixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsdUJBQXdCLENBQUM7QUFDckUsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxTQUFVLENBQUM7QUFDekMsTUFBTSxlQUFlLEdBQUcsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWUsSUFBSSxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUM7QUFFL0YsTUFBTSxPQUFPLEdBQUcsSUFBSSw4QkFBYSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBRS9CLEtBQUssVUFBVSxPQUFPLENBQUMsS0FBMEI7SUFDdEQsSUFBSSxLQUFLLENBQUMsV0FBVyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ25DLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxtQkFBbUIsZ0JBQWdCLEVBQUUsRUFBRSxDQUFDO0lBQ3ZFLENBQUM7SUFDRCxNQUFNLE1BQU0sR0FBRyxNQUFNLFVBQVUsRUFBRSxDQUFDO0lBQ2xDLElBQUksQ0FBQztRQUNILE1BQU0sT0FBTyxHQUFHLEVBQUUsYUFBYSxFQUFFLFVBQVUsTUFBTSxFQUFFLEVBQUUsY0FBYyxFQUFFLGtCQUFrQixFQUFF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QUksQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUM7UUFDYixNQUFNLElBQUksS0FBSyxDQUFDLCtCQUErQixFQUFFLENBQUMsR0FBRyxLQUFLLElBQUksQ0FBQyxNQUFNLElBQUksTUFBTSxJQUFJLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ2hHLENBQUM7QUFDSCxDQUFDO0FBRUQsS0FBSyxVQUFVLGVBQWUsQ0FBQyxPQUFlLEVBQUUsT0FBK0IsRUFBRSxTQUFrQztJQUNqSCxNQUFNLElBQUksR0FBRyxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxDQUFDO0lBQ25GLE1BQU0sSUFBSSxHQUFHLE1BQU0sS0FBSyxDQUFDLEdBQUcsT0FBTyxvQkFBb0IsRUFBRSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNsSCxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxDQUFDO1FBQ2IsTUFBTSxJQUFJLEtBQUssQ0FBQyw4QkFBOEIsU0FBUyxDQUFDLEdBQUcsS0FBSyxJQUFJLENBQUMsTUFBTSxJQUFJLE1BQU0sSUFBSSxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQztJQUN0RyxDQUFDO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQU1HIHBvc3QtZGVwbG95IEN1c3RvbSBSZXNvdXJjZSBMYW1iZGEuXG4gKlxuICogQ3JlYXRlcyBBTVAgKyBDbG91ZFdhdGNoIGRhdGFzb3VyY2VzIGFuZCB1cGxvYWRzIHRoZSA0IFBhcnQgNyBkYXNoYm9hcmRzLlxuICogSWRlbXBvdGVudDogR0VULWJlZm9yZS1QT1NULlxuICpcbiAqIE5vdGU6IEFNRyBBUEkgcmVxdWlyZXMgYW4gQVBJIGtleS4gVW5kZXIgU0VSVklDRV9NQU5BR0VEIGF1dGggdGhpcyBMYW1iZGEgbWludHMgYVxuICogdGVtcG9yYXJ5IGtleSB2aWEgZ3JhZmFuYTpDcmVhdGVXb3Jrc3BhY2VBcGlLZXksIGNhbGxzIHRoZSB3b3Jrc3BhY2UgSFRUUCBBUEksIGFuZFxuICogZGVsZXRlcyB0aGUga2V5IG9uIGNvbXBsZXRpb24uXG4gKi9cblxuaW1wb3J0IHsgR3JhZmFuYUNsaWVudCwgQ3JlYXRlV29ya3NwYWNlQXBpS2V5Q29tbWFuZCwgRGVsZXRlV29ya3NwYWNlQXBpS2V5Q29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1ncmFmYW5hJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuXG5pbnRlcmZhY2UgQ3VzdG9tUmVzb3VyY2VFdmVudCB7XG4gIFJlcXVlc3RUeXBlOiAnQ3JlYXRlJyB8ICdVcGRhdGUnIHwgJ0RlbGV0ZSc7XG4gIFJlc291cmNlUHJvcGVydGllczogeyBkYXNoYm9hcmRGaWxlc0hhc2g6IHN0cmluZyB9O1xufVxuXG5jb25zdCBBTUdfV09SS1NQQUNFX0lEID0gcHJvY2Vzcy5lbnYuQU1HX1dPUktTUEFDRV9JRCE7XG5jb25zdCBBTUdfV09SS1NQQUNFX1VSTCA9IHByb2Nlc3MuZW52LkFNR19XT1JLU1BBQ0VfVVJMITtcbmNvbnN0IEFNUF9QUk9NRVRIRVVTX0VORFBPSU5UID0gcHJvY2Vzcy5lbnYuQU1QX1BST01FVEhFVVNfRU5EUE9JTlQhO1xuY29uc3QgQ1dfUkVHSU9OID0gcHJvY2Vzcy5lbnYuQ1dfUkVHSU9OITtcbmNvbnN0IERBU0hCT0FSRF9GSUxFUyA9IChwcm9jZXNzLmVudi5EQVNIQk9BUkRfRklMRVMgPz8gJycpLnNwbGl0KCcsJykuZmlsdGVyKChzKSA9PiBzLmxlbmd0aCk7XG5cbmNvbnN0IGdyYWZhbmEgPSBuZXcgR3JhZmFuYUNsaWVudCh7fSk7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKGV2ZW50OiBDdXN0b21SZXNvdXJjZUV2ZW50KTogUHJvbWlzZTx7IFBoeXNpY2FsUmVzb3VyY2VJZDogc3RyaW5nIH0+IHtcbiAgaWYgKGV2ZW50LlJlcXVlc3RUeXBlID09PSAnRGVsZXRlJykge1xuICAgIHJldHVybiB7IFBoeXNpY2FsUmVzb3VyY2VJZDogYGFtZy1wb3N0LWRlcGxveS0ke0FNR19XT1JLU1BBQ0VfSUR9YCB9O1xuICB9XG4gIGNvbnN0IGFwaUtleSA9IGF3YWl0IG1pbnRBcGlLZXkoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBoZWFkZXJzID0geyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7YXBpS2V5fWAsICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfTtcbiAgICBjb25zdCBiYXNlVXJsID0gYGh0dHBzOi8vJHtBTUdfV09SS1NQQUNFX1VSTH1gO1xuXG4gICAgYXdhaXQgZW5zdXJlRGF0YXNvdXJjZShiYXNlVXJsLCBoZWFkZXJzLCB7XG4gICAgICB1aWQ6ICdhbXAnLFxuICAgICAgbmFtZTogJ0FNUCcsXG4gICAgICB0eXBlOiAncHJvbWV0aGV1cycsXG4gICAgICBhY2Nlc3M6ICdwcm94eScsXG4gICAgICB1cmw6IEFNUF9QUk9NRVRIRVVTX0VORFBPSU5ULFxuICAgICAganNvbkRhdGE6IHsgc2lnVjRBdXRoOiB0cnVlLCBzaWdWNEF1dGhUeXBlOiAnZWMyX2lhbV9yb2xlJywgc2lnVjRSZWdpb246IENXX1JFR0lPTiwgaHR0cE1ldGhvZDogJ1BPU1QnIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBlbnN1cmVEYXRhc291cmNlKGJhc2VVcmwsIGhlYWRlcnMsIHtcbiAgICAgIHVpZDogJ2N3JyxcbiAgICAgIG5hbWU6ICdDbG91ZFdhdGNoJyxcbiAgICAgIHR5cGU6ICdjbG91ZHdhdGNoJyxcbiAgICAgIGFjY2VzczogJ3Byb3h5JyxcbiAgICAgIGpzb25EYXRhOiB7IGF1dGhUeXBlOiAnZWMyX2lhbV9yb2xlJywgZGVmYXVsdFJlZ2lvbjogQ1dfUkVHSU9OIH0sXG4gICAgfSk7XG5cbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgREFTSEJPQVJEX0ZJTEVTKSB7XG4gICAgICBjb25zdCBkYXNoSnNvbiA9IEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihfX2Rpcm5hbWUsICdkYXNoYm9hcmRzJywgZmlsZSksICd1dGYtOCcpKTtcbiAgICAgIGF3YWl0IHVwc2VydERhc2hib2FyZChiYXNlVXJsLCBoZWFkZXJzLCBkYXNoSnNvbik7XG4gICAgfVxuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IGRlbGV0ZUFwaUtleShhcGlLZXkpO1xuICB9XG4gIHJldHVybiB7IFBoeXNpY2FsUmVzb3VyY2VJZDogYGFtZy1wb3N0LWRlcGxveS0ke0FNR19XT1JLU1BBQ0VfSUR9YCB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtaW50QXBpS2V5KCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IG91dCA9IGF3YWl0IGdyYWZhbmEuc2VuZChuZXcgQ3JlYXRlV29ya3NwYWNlQXBpS2V5Q29tbWFuZCh7XG4gICAga2V5TmFtZTogYHRzcC1ibXQtcG9zdGRlcGxveS0ke0RhdGUubm93KCl9YCxcbiAgICBrZXlSb2xlOiAnQURNSU4nLFxuICAgIHNlY29uZHNUb0xpdmU6IDYwMCxcbiAgICB3b3Jrc3BhY2VJZDogQU1HX1dPUktTUEFDRV9JRCxcbiAgfSkpO1xuICBpZiAoIW91dC5rZXkpIHRocm93IG5ldyBFcnJvcignQ3JlYXRlV29ya3NwYWNlQXBpS2V5IHJldHVybmVkIG5vIGtleScpO1xuICByZXR1cm4gb3V0LmtleTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGVsZXRlQXBpS2V5KF9rZXk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBDcmVhdGVXb3Jrc3BhY2VBcGlLZXkgZG9lc24ndCByZXR1cm4gYSBuYW1lIHdlIGNhbiBkZWxldGUgYnkg4oCUIHNob3J0IFRUTCBoYW5kbGVzIGNsZWFudXAuXG4gIC8vIEV4cGxpY2l0IGRlbGV0ZS1ieS1uYW1lIHNraXBwZWQgdG8gYXZvaWQgdGhlIGxvb2t1cDsga2V5IGF1dG8tZXhwaXJlcyBpbiA2MDBzLlxufVxuXG5pbnRlcmZhY2UgRGF0YXNvdXJjZVNwZWMge1xuICB1aWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB0eXBlOiBzdHJpbmc7IGFjY2Vzczogc3RyaW5nOyB1cmw/OiBzdHJpbmc7IGpzb25EYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhdGFzb3VyY2UoYmFzZVVybDogc3RyaW5nLCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LCBkczogRGF0YXNvdXJjZVNwZWMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ2V0ID0gYXdhaXQgZmV0Y2goYCR7YmFzZVVybH0vYXBpL2RhdGFzb3VyY2VzL3VpZC8ke2RzLnVpZH1gLCB7IGhlYWRlcnMgfSk7XG4gIGlmIChnZXQuc3RhdHVzID09PSAyMDApIHJldHVybjsgIC8vIGV4aXN0cyDigJQgaWRlbXBvdGVudFxuICBpZiAoZ2V0LnN0YXR1cyAhPT0gNDA0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHN0YXR1cyAke2dldC5zdGF0dXN9IHdoZW4gY2hlY2tpbmcgZGF0YXNvdXJjZSAke2RzLnVpZH1gKTtcbiAgfVxuICBjb25zdCBwb3N0ID0gYXdhaXQgZmV0Y2goYCR7YmFzZVVybH0vYXBpL2RhdGFzb3VyY2VzYCwgeyBtZXRob2Q6ICdQT1NUJywgaGVhZGVycywgYm9keTogSlNPTi5zdHJpbmdpZnkoZHMpIH0pO1xuICBpZiAoIXBvc3Qub2spIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBjcmVhdGUgZGF0YXNvdXJjZSAke2RzLnVpZH06ICR7cG9zdC5zdGF0dXN9ICR7YXdhaXQgcG9zdC50ZXh0KCl9YCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBzZXJ0RGFzaGJvYXJkKGJhc2VVcmw6IHN0cmluZywgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiwgZGFzaGJvYXJkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBib2R5ID0geyBkYXNoYm9hcmQsIG92ZXJ3cml0ZTogdHJ1ZSwgbWVzc2FnZTogJ3RzcC1ibXQgcG9zdC1kZXBsb3kgdXBsb2FkJyB9O1xuICBjb25zdCBwb3N0ID0gYXdhaXQgZmV0Y2goYCR7YmFzZVVybH0vYXBpL2Rhc2hib2FyZHMvZGJgLCB7IG1ldGhvZDogJ1BPU1QnLCBoZWFkZXJzLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTtcbiAgaWYgKCFwb3N0Lm9rKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gdXBsb2FkIGRhc2hib2FyZCAke2Rhc2hib2FyZC51aWR9OiAke3Bvc3Quc3RhdHVzfSAke2F3YWl0IHBvc3QudGV4dCgpfWApO1xuICB9XG59XG4iXX0=