# `web-api/` — API Lambda 13개

운영자 콘솔 뒤에서 도는 API Gateway Lambda들. 각 함수는 단일 책임이고 `web-api/src/lib/` 모듈을 공유합니다.

## 라우트 매핑

| 경로 | 메서드 | Lambda 파일 | 설명 |
|---|---|---|---|
| `/runs` | GET | `list-runs.ts` | 최근 run 목록 (DDB scan) |
| `/runs` | POST | `start-run.ts` | 새 run 생성 + SSM SendCommand로 로더 EC2에 orchestrate.sh 실행 |
| `/runs/{id}` | GET | `get-run.ts` | run 상세 + unit 목록 |
| `/runs/{id}/status` | GET | `get-run-status.ts` | 진행률 + ETA + completedAt (live 페이지가 5s 폴링) |
| `/runs/{id}/abort` | POST | `abort-run.ts` | SSM Parameter abort flag + SSM SendCommand로 자식 프로세스 SIGTERM |
| `/reports/{id}` | GET | `report-html-redirect.ts` | S3 presigned URL → 302 redirect |
| `/reports/{id}/pdf` | GET | `report-pdf-redirect.ts` | 동상 (PDF) |
| `/loader-info` | GET | `get-loader-info.ts` | 현재 publish된 loader binary의 versionId/sha256 |
| `/cluster/status` | GET | `cluster-status.ts` | 클러스터 상태 + uiState (idle/scaling/degraded/stale) |
| `/cluster/provision` | POST | `cluster-provision.ts` | hard-scale-cluster.sh 호출 (admin 전용) |
| `/cluster/force-unlock` | POST | `cluster-force-unlock.ts` | stale lock 강제 해제 (admin 전용) |
| (Authorizer) | — | `custom-authorizer.ts` | 모든 라우트 앞단에서 실행되는 REQUEST authorizer |
| (Cognito Trigger) | — | `pre-token-gen.ts` | Cognito Pre-token-gen V2 — JWT에 `custom:sessionId` 주입 |

## 인증 모델

- **Cognito User Pool** — Hosted UI(PKCE)로 로그인. 그룹: `admin`, `viewer`.
- **Pre-token-gen V2 Lambda** — 사용자 로그인 시 새 `sessionId`(UUID) 생성 → DDB `bmt-admin-sessions`에 저장 → JWT의 `custom:sessionId` 클레임에 주입.
- **Custom REQUEST authorizer** — 모든 API 호출 앞단에서 실행. JWT 검증 + `custom:sessionId`가 DDB의 현재 sessionId와 일치하는지 확인. 다른 브라우저에서 로그인하면 이전 세션 무효화 (single-admin 정책).
- **그룹별 게이트** — `web-api/src/lib/auth.ts`의 `ENDPOINT_MATRIX`가 라우트별 권한(`admin` / `viewer` / `either`)을 정의. mutating 라우트(`POST /runs`, `POST /cluster/provision` 등)는 admin 전용.

## 공유 모듈 (`src/lib/`)

- **`auth.ts`** — `ENDPOINT_MATRIX`, JWT 디코드/검증, `rangeError()` 헬퍼.
- **`cluster.ts`** — `readClusterState()`, `readClusterStatus()`, `readActiveHsmCount()`, `computeRequiredStartHsmCount()`. SSM + cloudhsmv2:DescribeClusters를 종합해 4가지 uiState 계산.
- **`ddb.ts`** — DocumentClient 싱글톤.
- **`lock.ts`** — DDB `bmt-runs-lock`의 conditional update로 single-admin run 락 획득/해제.
- **`types.ts`** — `MatrixSubset`, `StartRunInput`, `validateMatrixSubset()`, JSON 응답 헬퍼.

## 핵심 흐름 — `POST /runs`

```
1. 인증 (custom-authorizer가 검증 끝낸 상태)
2. 입력 검증 (validateMatrixSubset)
3. cluster pre-flight (readClusterState — scaling이면 409)
4. ACTIVE HSM count gate (현재 cs < required면 422 cluster_not_ready)
5. Run-level 락 획득 (DDB conditional update on bmt-runs-lock)
6. DDB bmt-runs에 PENDING row insert
7. /etc/hsm-bmt/runner.env 생성 + /usr/local/bin/hsm-bmt-orchestrate.sh 실행 (SSM SendCommand)
8. 202 Accepted 응답 (runId)
```

실패하면 단계별 롤백 (락 해제 + Run row를 FAILED로 마킹).

## 빌드 & 테스트

```bash
cd web-api
npm install
npm run build       # tsc — type check만, 번들링은 CDK가 esbuild로 처리
npm test            # jest + aws-sdk-client-mock
```

테스트:
- `tests/start-run.test.ts` — pre-flight, 락 획득, 입력 검증
- `tests/abort-run.test.ts` — abort 신호 (SSM Parameter + SendCommand 둘 다)
- `tests/concurrency.test.ts` — single-admin 락 충돌 케이스
- `tests/auth.test.ts` — `ENDPOINT_MATRIX` 권한 매핑
- `tests/custom-authorizer.test.ts` — sessionId 검증
- `tests/pre-token-gen.test.ts` — Cognito 트리거 V2 응답 형식

## 배포

CDK `WebStack`의 `ApiConstruct`가 13개 Lambda를 `aws-cdk-lib.aws-lambda-nodejs.NodejsFunction`로 패키징 + esbuild 번들링까지 처리. 따로 빌드할 필요 없이 `npx cdk deploy WebStack`만 실행하면 됩니다.

## 환경 변수 (각 Lambda)

런타임 환경 변수는 `iac/lib/constructs/api-construct.ts`에서 일괄 주입:

- `RUNS_TABLE`, `UNITS_TABLE`, `RUNS_LOCK_TABLE`, `ADMIN_SESSIONS_TABLE`
- `RESULTS_BUCKET`
- `LOADER_INSTANCE_ID`
- `ABORT_SSM_PREFIX` (`/<prefix>/runs/`)
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`
