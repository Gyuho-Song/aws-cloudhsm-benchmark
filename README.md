# AWS CloudHSM Benchmark (HOS edition)

AWS CloudHSM v2 (`hsm2m.medium`, FIPS) 클러스터의 **처리량(ops/sec)**과 **지연시간(p50/p95/p99)**을 운영 환경과 동일한 방식으로 측정하기 위한 end-to-end 벤치마크 시스템입니다. PKCS#11 직접 호출을 사용하는 C 네이티브 로더, 운영자용 Next.js 콘솔, 측정 후 PDF/HTML 리포트 생성까지 한 묶음으로 제공합니다.

## 핵심 특징

- **HARD scale 측정**: 클러스터 크기 변경(cs=2~6)을 `cloudhsmv2:DeleteHsm` / `CreateHsm`로 실제 HSM 갯수를 바꿔가며 측정합니다. 로더 설정만 토글하는 soft scale은 mesh 동작이 다르기 때문에 폐기되었습니다.
- **C 네이티브 로더**: PKCS#11 라이브러리(`/opt/cloudhsm/lib/libcloudhsm_pkcs11.so`)를 `dlopen` + `pthread`로 직접 호출합니다. JVM/JCE 오버헤드 없음.
- **Multi-process 포화**: 하나의 cell당 N개의 별도 프로세스를 띄워 mTLS connection pool과 PKCS#11 세션을 분리합니다. cs별 sweet-spot은 `procsByCluster`에 박혀 있습니다 (cs=6→procs=12, 5→12, 4→10, 3→8, 2→6).
- **클러스터 상태 인식**: SSM Parameter `/<prefix>/core/cluster-state` 락 + UI 헤더 chip으로 scaling 진행 / stale lock / degraded 상태를 운영자에게 명확히 노출합니다.
- **운영자 콘솔**: Cognito Hosted UI(PKCE) → Custom REQUEST authorizer → API Gateway → Lambda 흐름. 시나리오 카드, pre-flight 패널, live progress, PDF/HTML 리포트 뷰어 포함.

## 디렉토리 구조

```
.
├── iac/        AWS CDK (TypeScript) 인프라 — VPC, HSM 클러스터, EC2 로더, DynamoDB, S3, Cognito,
│              API Gateway + Lambdas, Grafana(AMG/AMP), CloudWatch 대시보드/알람, IAM
├── web/        Next.js 14 (App Router) 운영자 콘솔 — 시나리오 선택, pre-flight, live, 리포트 뷰어
├── web-api/    웹 API용 Lambda 핸들러 13개 (TypeScript) + 커스텀 authorizer + pre-token-gen
├── bench/      C 네이티브 PER_CALL_RAW 벤치 + OTLP/HTTP 익스포터
├── scripts/    로더 EC2에 설치되는 orchestrator + per-call wrapper + smoke + 핸드오버 유틸
├── report/     Python 리포트 생성기 (WeasyPrint) — Parquet 입력 → 한국어 PDF + HTML 출력
└── README.md   (이 파일)
```

각 서브디렉토리에 자체 README가 있으니 빌드/배포/테스트 절차는 거기서 확인하세요.

## 시나리오

운영자 콘솔(`/runs/new`)이 노출하는 4개 시나리오:

| ID | 이름 | 매트릭스 | 클러스터 정책 | 소요시간 |
|---|---|---|---|---|
| `smoke` | Smoke | AES-128 × ECB·GCM × 256·1024B × cs=6 × procs=4 | 시작 시 cs=6 필요 | ~30분 |
| `per-call-full-hard` | PER_CALL · Full | AES-128/256 × 5 modes × 256/1024B × cs 6→5→4→3→2 (HSM-adaptive procs) | 100 unit, cs=6 시작 → 종료 시 cs=2 유지 | ~13시간 |
| `per-call-partial-hard` | PER_CALL · Partial | AES-128/256 × 5 modes × 256/1024B × 단일 cs (운영자 선택) | cs=6 시작 → 선택한 사이즈로 축소, 측정 후 유지 | ~30~120분 |
| `custom-hard` | Custom | 운영자가 axis 직접 선택 (단일 cluster size) | 자동 (PreFlightPanel이 +N 프로비저닝 안내) | 가변 |

모든 시나리오는 HARD 스케일을 사용합니다. 단순화·일관성을 위해 logical/V3/multi-cluster 시나리오는 모두 폐기되었습니다.

## 데이터 흐름

```
[/runs/new 운영자]
   ↓ (Cognito access token)
[API Gateway → Custom Authorizer → start-run Lambda]
   ↓ (DDB row + SSM Run Command)
[로더 EC2: orchestrate.sh]
   ↓ (per-call-bench-wrapper.sh × N procs)
[per_call_bench (C, PKCS#11) → CloudHSM cluster]
   ↓
   ├─ Parquet → S3 (per-proc results)
   ├─ DDB bmt-units (per-cell ops/sec, p99)
   └─ OTLP/HTTP → ADOT → AMP / CloudWatch
                                  ↓
[리포트 Lambda 트리거] → render-report.sh → Python report 생성기
   → S3에 PDF/HTML 업로드 → /runs/[id]/report 페이지에서 표시
```

## 운영 식별자 prefix

코드 전체에서 SSM path / S3 bucket / DDB table / 환경 변수 / systemd unit 이름이 모두 `hsm-bmt` 또는 `HSM_BMT_` prefix로 통일되어 있습니다. 본인 환경에 맞게 변경하려면 다음 5곳을 일괄 sed로 치환하세요:

- SSM path 트리: `/<prefix>/core/...`, `/<prefix>/runs/{runId}/...`
- S3 bucket 이름: `<prefix>-results-<account-id>-<region>`
- DDB 테이블: `bmt-runs`, `bmt-units`, `bmt-runs-lock`, `bmt-admin-sessions`
- 환경 변수: `HSM_BMT_PROCS`, `HSM_BMT_WORKER_COUNT`, `HSM_BMT_CLUSTER_SIZES`, …
- 파일/디렉토리: `/var/log/<prefix>`, `/etc/<prefix>`, `/opt/<prefix>`, `hsm-bmt-orchestrate.sh`, `hsm_bmt_report/`, `hsm-bmt.ts`(CDK app entry)

## 빠른 시작

상세 절차는 각 서브디렉토리 README 참고. 대략적인 순서:

1. `iac/` — `npm install` → `cdk deploy CoreStack`
2. `iac/scripts/cluster-create.sh` 실행 — CloudHSM 클러스터 생성 + activation
3. `iac/scripts/provision-keys.sh` — KEK(`BMT_KEK_AES128/256`) 사전 생성
4. 로더 EC2에 `bench/per_call_bench.c` 빌드 후 S3 업로드 + sha256 SSM에 기록
5. `iac/` — `cdk deploy WebStack ObservabilityStack`
6. Cognito 운영자 시드 (`scripts/seed-handover-users.sh`)
7. Hosted UI 로그인 → `/runs/new` → Smoke 실행으로 end-to-end 검증

## 라이선스

MIT (또는 운영자가 채택하는 라이선스 명시).

## 기여

이 저장소는 한 번에 정리된 공개판입니다. 이슈 / PR 환영합니다.
