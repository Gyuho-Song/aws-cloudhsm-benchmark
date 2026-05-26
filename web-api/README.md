# `web-api/` — CloudHSM BMT Web Console API Lambdas (Unit 5)

Seven Lambda functions backing the operator web console:

| Path | Method | Lambda | Action |
|---|---|---|---|
| `/runs` | POST | `start-run` | Create run + SSM SendCommand to loader EC2 |
| `/runs/{id}/abort` | POST | `abort-run` | Write SSM Parameter Store abort signal |
| `/runs` | GET | `list-runs` | List recent runs |
| `/runs/{id}` | GET | `get-run` | Run + units summary |
| `/runs/{id}/status` | GET | `get-run-status` | Live status with ETA |
| `/reports/{id}` | GET | `report-html-redirect` | 302 to S3 presigned `report.html` |
| `/reports/{id}/pdf` | GET | `report-pdf-redirect` | 302 to S3 presigned `report.pdf` |

All endpoints require Cognito JWT (handled by API Gateway authorizer in `iac/lib/constructs/api-construct.ts`).

## Build / Test

```bash
cd web-api
npm install
npm test          # jest unit tests with aws-sdk-client-mock
```

CDK packages each Lambda via `aws-cdk-lib.aws-lambda-nodejs.NodejsFunction`; no manual bundling needed.
