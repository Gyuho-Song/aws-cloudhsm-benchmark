# `scripts/` — 로더 EC2 측정 스크립트 + 핸드오프 유틸

로더 EC2에 설치되어 실제 측정을 수행하는 셸 스크립트들. `iac/assets/loader-bootstrap.sh`의 user-data가 이 디렉토리의 파일을 `/usr/local/bin/`으로 복사합니다.

## 파일 별 책임

### `hsm-bmt-orchestrate.sh`
측정 흐름 전체를 관장하는 **상위 orchestrator**. 진입점은 `web-api/start-run.ts`가 SSM SendCommand로 호출.

- `/etc/hsm-bmt/runner.env`에서 RUN_ID, EXPECTED_VERSION_ID, EXPECTED_SHA256, S3_BUCKET, HSM_BMT_PROCS, HSM_BMT_CLUSTER_SIZES 등을 읽어들임
- cluster-state SSM이 `scaling`이면 즉시 종료 (pre-flight gate)
- DDB `bmt-runs` status를 PENDING → RUNNING으로 갱신 + Run-level 락 획득
- `HSM_BMT_CLUSTER_SIZES` (예: `6,5,4,3,2`)를 순차로 sweep:
  1. 현재 ACTIVE HSM 수 ≠ target → `hard-scale-cluster.sh <target>` 호출
  2. 이미 target → 스킵 (불필요한 mesh 재구성 방지)
  3. `HSM_BMT_PROCS_BY_CLUSTER` 매핑이 있으면 cs별 sweet-spot procs로 override
  4. `per-call-bench-wrapper.sh`를 백그라운드로 실행 + 추적된 PID로 `wait` (SIGTERM 인터럽트 가능)
- 셀별 abort 시그널 폴링 (`/<prefix>/runs/<runId>/abort` SSM)
- `set -e ERR trap` + `EXIT trap` 으로 어떤 종료 경로에서도 status를 FAILED로 마킹 + Run lock 해제
- 측정 종료 시 cluster size 그대로 유지 (자동 reset 없음). 다음 run의 PreFlight가 부족하면 운영자에게 알림

### `per-call-bench-wrapper.sh`
PER_CALL family용 cell-단위 wrapper. `orchestrate.sh`가 cell별로 호출.

- `HSM_BMT_PROCS` (전역) 또는 payload별 `HSM_BMT_PROCS_256` / `HSM_BMT_PROCS_1024`로 N개 프로세스 fork
- 각 프로세스는 `/usr/local/bin/per_call_bench` (C 네이티브)를 실행 — algo/mode/payload, threads(=workers), seconds 인자 전달
- 모든 프로세스 join 후 결과 집계: `tx_per_sec`는 합, p99는 per-proc 최댓값, p50는 weighted mean
- DDB `bmt-units` row 업데이트 (status=COMPLETED, opsPerSec, p99Ns, errors)
- per-proc Parquet을 S3에 업로드 (`runs/{runId}/family=PER_CALL_RAW/unit={unitId}/proc={i}/result.parquet`)
- bench binary가 `/usr/local/bin/per_call_bench`에 없으면 S3에서 자동 복원 (재부팅 후 `/tmp` 휘발성 회피)

### `customer-handover-smoke.sh`
배포 직후 운영 전 사전 점검용 1-shot smoke 테스트.

- HSM 클러스터 상태 확인 (cs=6 ACTIVE 검증)
- `BMT_KEK_AES128/256` 키 존재 검증 (`provision-keys.sh` 확인)
- `per_call_bench` 바이너리 SHA-256 검증
- AC-3, AC-5, AC-5b, AC-6 acceptance criteria 검증
- 결과를 stdout + S3 (`smoke/{date}.json`)에 기록

### `seed-handover-users.sh`
운영자 Cognito 사용자 시드. 배포 직후 1회 실행.

- 기본 admin 1명, viewer 1명 생성
- 임시 비밀번호 발급 + 첫 로그인 시 변경 강제
- 그룹 소속(`admin` / `viewer`) 부여
- 사용자가 옵션 인자로 추가 사용자 정의 가능

### `sync-report-package.sh`
로컬에서 수정한 `report/` 패키지를 로더 EC2로 동기화하는 개발 유틸.

- `report/src/`, `report/templates/`, `report/static/` 을 tar로 압축
- S3에 임시 업로드 → SSM SendCommand로 EC2에 다운로드 + 압축 해제
- 측정 종료 후 자동 호출되는 `render-report.sh`가 새 코드로 동작
- 운영 환경 외에 dev workflow 전용

## 환경 변수 (orchestrate.sh가 읽는 키)

`/etc/hsm-bmt/runner.env`에 정의되며, `start-run` Lambda가 작성:

| 변수 | 설명 |
|---|---|
| `RUN_ID` | DDB run ID (`rid-YYYYMMDDHHMMSS`) |
| `EXPECTED_VERSION_ID` | S3에 publish된 loader binary의 versionId |
| `EXPECTED_SHA256` | 동상의 sha256 (binary 검증용) |
| `S3_BUCKET` | 결과 업로드 대상 (`hsm-bmt-results-<account>-<region>`) |
| `HSM_BMT_RUNNER` | `c-native-multiproc` (현재 유일하게 지원) |
| `HSM_BMT_PROCS` | cell당 프로세스 수 (1~16) |
| `HSM_BMT_PROCS_BY_CLUSTER` | `6:12,5:12,4:10,3:8,2:6` 형식 — cs별 sweet-spot |
| `HSM_BMT_PROCS_256` / `_1024` | payload별 procs override (선택) |
| `HSM_BMT_WORKER_COUNT` | 프로세스당 thread 수 (기본 64) |
| `HSM_BMT_CLUSTER_SIZES` | sweep 순서 (예: `6,5,4,3,2`) |
| `HSM_BMT_AUTO_SCALE` | `1`이면 sweep, `0`이면 단일 패스 |
| `HSM_BMT_HARD_SCALE` | `1` 고정 |
| `HSM_BMT_FAMILY` | `PER_CALL_RAW` 고정 |
| `HSM_BMT_ALGOS` / `_MODES` / `_PAYLOADS` | 매트릭스 axis (csv) |

## SSM 파라미터 의존성

orchestrate.sh가 읽거나 쓰는 SSM 키:

- `read`: `/<prefix>/core/cluster-id`, `/<prefix>/core/desired-hsm-count`, `/<prefix>/runs/<runId>/abort`
- `write` (간접 via DDB): `bmt-runs.status`, `bmt-runs-lock.activeRunId`
- `read+write` (hard-scale-cluster.sh가 처리): `/<prefix>/core/cluster-state`, `/<prefix>/core/cluster-state-since`, `/<prefix>/core/cluster-state-target`, `/<prefix>/core/hard-scale-status`

## 종속 바이너리

- `/usr/local/bin/per_call_bench` — `bench/per_call_bench.c`를 gcc로 빌드한 결과 (S3 업로드 + 부팅 시 자동 다운로드)
- `/usr/local/bin/hard-scale-cluster.sh` — `iac/assets/hard-scale-cluster.sh` (loader-bootstrap.sh가 설치)
- `/opt/cloudhsm/lib/libcloudhsm_pkcs11.so` — CloudHSM Client SDK 5

## 디버깅

```bash
# 로그
sudo tail -f /var/log/hsm-bmt/orchestrate.log
sudo tail -f /var/log/hsm-bmt/per-call-bench-wrapper.log
sudo tail -f /var/log/hsm-bmt/hard-scale-cluster.log

# 진행 중 프로세스 확인
pgrep -af hsm-bmt-orchestrate
pgrep -af per_call_bench
pgrep -af hard-scale-cluster

# Run lock 상태
aws ssm get-parameter --name /<prefix>/core/cluster-state --query Parameter.Value --output text
aws dynamodb get-item --table-name bmt-runs-lock --key '{"key":{"S":"global"}}'
```
