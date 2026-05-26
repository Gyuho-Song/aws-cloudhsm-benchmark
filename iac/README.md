# `iac/` — AWS CDK 인프라

CloudHSM 벤치마크 시스템의 모든 AWS 리소스를 정의하는 CDK 앱(TypeScript). VPC와 HSM 클러스터부터 Cognito·API Gateway·Grafana(AMG/AMP)·CloudWatch까지 한 번에 합성·배포합니다.

## 스택 구성

3개 스택으로 분리되어 있습니다.

| Stack | 무엇을 만드나 | 의존 |
|---|---|---|
| `CoreStack` | VPC(4 AZ) + 보안그룹 + CloudHSM v2 클러스터 + 로더 EC2 + S3 결과 버킷 + Secrets Manager(CA/CO/CU) + IAM(LoaderInstanceRole, OperatorRole) + CodeCommit/GitHub repository | 없음 (스택 진입점) |
| `WebStack` | Cognito User Pool + Hosted UI + DynamoDB(`bmt-runs/units/lock/admin-sessions`) + API Gateway + Lambda 13개 + CloudFront + 운영자 콘솔 정적 호스팅 + Pre-token-gen 트리거 + 인증 알람 | `CoreStack` |
| `ObservabilityStack` | AMP(Prometheus) workspace + AMG(Grafana) workspace + ADOT 콜렉터 설정 + CloudWatch 대시보드 3종 + AlertManager (Slack/SNS) | `CoreStack` |

## 디렉토리

```
bin/
  hsm-bmt.ts                  CDK app entry — 3 스택 인스턴스화

lib/
  core-stack.ts               CoreStack 본체
  web-stack.ts                WebStack 본체
  observability-stack.ts      ObservabilityStack 본체
  constructs/
    network-construct.ts      VPC + 4 private subnet + VPC endpoint (S3, SSM, KMS, …)
    iam-construct.ts          LoaderInstanceRole + 크로스어카운트 OperatorRole
    crypto-construct.ts       Secrets Manager 3개 (CA private key placeholder, CO 패스워드, CU 패스워드)
    hsm-cluster-construct.ts  CloudHSM v2 클러스터 placeholder + hsm-slots SSM (logical-az 매핑은 cluster-create.sh에서)
    loader-instance-construct.ts  c8i.8xlarge 로더 EC2 + 인스턴스 프로파일 + bootstrap user-data
    storage-construct.ts      결과 저장용 S3 버킷 (KMS, lifecycle, public block)
    repository-construct.ts   CodeCommit (또는 GitHub 핸드오프 SSM 파라미터)
    cognito-construct.ts      User Pool + Hosted UI + admin/viewer 그룹
    dynamodb-construct.ts     bmt-runs / bmt-units / bmt-runs-lock / bmt-admin-sessions
    api-construct.ts          REST API + 14개 라우트 + GatewayResponse(401/403 한국어)
    auth-lambdas-construct.ts custom-authorizer + pre-token-gen Lambda 정의
    auth-alarms-construct.ts  authorizer 4xx 알람, lock 충돌 알람 등
    frontend-construct.ts     S3 + CloudFront + OAC, web/out/ asset 배포
    amp-construct.ts          AMP workspace + remote-write 권한
    amg-construct.ts          AMG workspace + AMP/CloudWatch 데이터소스
    adot-config-construct.ts  ADOT 콜렉터 설정 S3에 업로드
    alert-construct.ts        SNS 알람 토픽 + Prometheus alert rule
    dashboard-construct.ts    CloudWatch 대시보드 (live / native-aws / per-call)

lambda/
  cluster-init/               CFN Custom Resource — 클러스터 placeholder 생성
  amg-post-deploy/            AMG workspace 생성 후 데이터소스/대시보드 자동 등록
  report-trigger/             DDB Streams → 측정 완료 시 render-report.sh 호출

scripts/                      CFN 외부에서 운영자가 직접 실행하는 셸
  cluster-create.sh           CloudHSM 클러스터 생성 + activation + KEK 사전 등록
  cluster-delete.sh           클러스터 안전 폐기 (모든 HSM 삭제 후 cluster delete)
  provision-keys.sh           BMT_KEK_AES128 / BMT_KEK_AES256 사전 생성 (cloudhsm-cli)
  amp-alert-manager-apply.sh  AlertManager 설정을 AMP에 PUT

assets/                       Lambda/EC2 user-data 또는 SSM SendCommand로 EC2에 푸시되는 파일
  loader-bootstrap.sh         로더 EC2 user-data — Corretto/CloudHSM SDK/ADOT/Python 설치, systemd unit 생성
  hard-scale-cluster.sh       HARD scale 도구 — DeleteHsm/CreateHsm로 cs 변경, flock + cluster-state SSM 락
  render-report.sh            로더 EC2에서 Python 리포트 생성 + S3 업로드
  adot-config.yaml            ADOT 콜렉터 설정 (OTLP/HTTP receiver, AMP remote-write)
  alert-manager.yaml          Prometheus AlertManager 라우팅 설정

alerts/
  hsm-bmt-rules.yaml          PromQL alert rules (HSM 갯수, 에러율, 워커 활성 등)

dashboards/                   AMG에 등록되는 Grafana 대시보드 JSON 3종
  live-run.json               진행 중 run의 cell-by-cell 진척도/지표
  native-aws.json             CloudWatch 네이티브 메트릭 (네트워크, 디스크, EBS)
  per-call.json               PER_CALL family 전용 (procs/workers, p99 분포)

test/                         Jest behavioral + snapshot 테스트 (오프라인, AWS 호출 없음)
```

## 빌드 & 테스트

```bash
cd iac
npm install
npm run build           # tsc — synth는 ts-node로도 가능하지만 prod는 빌드 후 사용
npm test                # 모든 construct + 스택 합성 검증, 오프라인
```

## 컨텍스트 변수 (`cdk.json` 또는 `--context`)

| 키 | 기본값 | 설명 |
|---|---|---|
| `desiredHsmCount` | `6` | 시작 시 HSM 갯수. 2~6 범위. cs 시나리오와 무관하게 hsm-slots SSM의 placeholder 갯수만 결정 |
| `clusterCount` | `1` | 단일 클러스터 (>1은 미사용) |
| `hsmsPerCluster` | `desiredHsmCount` | 단일 클러스터 경로에서는 지정 불필요 |
| `sdsAccountId` | `000000000000` | 핸드오프 파트너의 AWS account ID (OperatorRole 신뢰 정책) |
| `sdsExternalId` | `hsm-bmt-handoff` | 크로스 어카운트 assume-role의 ExternalId |
| `repositoryProvider` | `codecommit` | `codecommit` 또는 `github`. github 선택 시 CodeCommit 대신 SSM 핸드오프 파라미터만 생성 |
| `enableCustomAuthorizer` | `true` | API Gateway authorizer 종류. `false`면 Cognito JWT authorizer fallback |

## 배포 절차

### 최초 1회

```bash
cd iac
npm install && npm run build
npx cdk bootstrap aws://${AWS_ACCOUNT}/ap-northeast-2

# Day 1 — 코어 인프라 + HSM 클러스터 placeholder
npx cdk deploy CoreStack --require-approval never

# Day 1 — CloudHSM 클러스터 실제 생성 + activation (CFN 밖에서 실행)
./scripts/cluster-create.sh
./scripts/provision-keys.sh        # BMT_KEK_AES128/256 등록

# Day 2 — 운영자 콘솔 + 관측성
npx cdk deploy WebStack ObservabilityStack --require-approval never
./scripts/amp-alert-manager-apply.sh
```

### 코드 변경 후

```bash
npm run build
npx cdk diff WebStack          # 변경 내용 확인 (Lambda asset 해시, IAM 정책 등)
npx cdk deploy WebStack --require-approval never
```

`web/out/` 가 frontend 배포 source (Next.js export 산출물). `npm run build`를 `web/`에서 먼저 돌려야 합니다.

### 클러스터 정리

```bash
./scripts/cluster-delete.sh    # 모든 HSM delete + 클러스터 delete (수 분 소요)
npx cdk destroy CoreStack WebStack ObservabilityStack
```

## 핸드오프

S3 버킷 `hsm-bmt-results-<account>-ap-northeast-2`:
- `runs/{runId}/` — 측정 결과 Parquet (per-proc 단위, 자동 만료 없음)
- `reports/{runId}/` — PDF + HTML 리포트

OperatorRole로 크로스 어카운트 read 가능:

```bash
aws sts assume-role \
  --role-arn arn:aws:iam::<account>:role/HsmBmt-OperatorRole \
  --external-id ${SDS_EXTERNAL_ID} \
  --role-session-name partner-readonly
```

## 주의 사항

- `iac/cdk.context.json`은 `.gitignore`되어 있습니다 (account 별 AZ 캐시). 첫 synth 시 자동 생성.
- `loader-instance-construct`는 user-data가 길어서 EC2 user-data 16KB 제한에 가깝습니다. 추가하려면 SSM Run Command로 분리하세요.
- 운영자 콘솔이 사용하는 `frontend-construct`는 `../web/out/`에서 정적 파일을 읽습니다. `web/` 빌드를 먼저 돌리지 않으면 합성 실패.
