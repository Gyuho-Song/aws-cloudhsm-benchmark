# `web/` — CloudHSM BMT Operator Web Console (Unit 5)

Next.js 14 SPA, static export, deployed to S3 + CloudFront.

## Pages

| Path | Component | Purpose |
|---|---|---|
| `/` | `OverviewPage` | Run history table |
| `/runs/new` | `RunControlPage` | MatrixSelector + Run button |
| `/runs/[id]/live` | `LiveStatusPage` | Progress, ETA, Abort (5s polling) |
| `/runs/[id]/dashboard` | `DashboardPage` | AMG iframe filtered by runId |
| `/runs/[id]/results` | `ResultsPage` | Completed unit table |
| `/runs/[id]/report` | `ReportPage` | HTML iframe + PDF download |

## Build

```bash
cd web
npm install
NEXT_PUBLIC_API_BASE=https://<api-id>.execute-api.ap-northeast-2.amazonaws.com/prod \
NEXT_PUBLIC_AMG_WORKSPACE_URL=<amg-workspace-id>.grafana-workspace.ap-northeast-2.amazonaws.com \
npm run build
# → web/out/ (static export)
```

CDK `FrontendConstruct` reads `web/out/` at synth and uploads via `BucketDeployment` to S3 + invalidates CloudFront.

## Tests

```bash
npm test
```

Jest + Testing Library. Currently covers `MatrixSelector` shape contract.

## Auth flow

1. User visits `https://<cloudfront>/` → static page tries `api.listRuns()`
2. Without a token, the API returns 401; the page redirects to Cognito Hosted UI
3. After PKCE callback, token is stored in `sessionStorage["hsm-bmt-id-token"]`
4. Subsequent fetches send `Authorization: Bearer <id_token>`

(Hosted UI callback handler is a small `/callback/page.tsx` to be added in a follow-up; the API client and overall flow are in place.)
