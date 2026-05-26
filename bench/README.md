# `bench/` — C 네이티브 PER_CALL_RAW 벤치 + OTLP 익스포터

CloudHSM PKCS#11 라이브러리를 `dlopen` + `pthread`로 직접 호출하는 측정 바이너리. JVM/JCE 오버헤드 없이 mTLS connection pool과 PKCS#11 세션이 직접 노출됩니다.

## 파일

```
bench/
├── per_call_bench.c    PER_CALL_RAW family 벤치 메인 (AES_128/256 × ECB/CBC/CTR/GCM/CMAC × 256/1024B)
├── otel_emit.c         OTLP/HTTP 익스포터 (gauge + histogram)
└── otel_emit.h         OTel emit API 헤더
```

## 빌드

로더 EC2 (Amazon Linux 2023, gcc 11) 기준:

```bash
sudo dnf install -y gcc

# CloudHSM SDK 5의 PKCS#11 헤더 + libcurl이 필요
sudo dnf install -y libcurl-devel

cd /home/ec2-user/bench   # 로컬에서는 어디든 OK

gcc -O2 -pthread -o per_call_bench \
    per_call_bench.c otel_emit.c \
    -ldl -lcurl
```

`-ldl`로 `libcloudhsm_pkcs11.so`를 런타임에 로드합니다 (빌드 타임 링킹 X).

빌드 후 S3에 업로드 + sha256을 SSM에 publish:

```bash
sha256sum per_call_bench
aws s3 cp per_call_bench s3://hsm-bmt-results-${ACCOUNT}-ap-northeast-2/loader-artifacts/per_call_bench-current
aws ssm put-parameter \
  --name /<prefix>/loader/version-id --type String \
  --value "$(aws s3api head-object --bucket ... --key loader-artifacts/per_call_bench-current --query VersionId --output text)" --overwrite
aws ssm put-parameter \
  --name /<prefix>/loader/sha256 --type String \
  --value "$(sha256sum per_call_bench | awk '{print $1}')" --overwrite
```

운영자가 `/runs/new`에서 입력하는 versionId/sha256과 EC2가 다운로드한 binary의 sha256이 일치해야 측정이 시작됩니다 (NFR-3.5).

## 실행

`per-call-bench-wrapper.sh`가 호출하는 형태:

```bash
CLOUDHSM_PIN="bmt_cu:<password>" \
  /usr/local/bin/per_call_bench \
    --algo aes_256 \
    --mode gcm \
    --payload 1024 \
    --threads 64 \
    --seconds 360 \
    --warmup-seconds 60 \
    --process-idx 0 \
    --cluster-size 6 \
    --otlp-endpoint http://localhost:4317 \
    --output-prefix /tmp/result-proc0
```

출력:
- `stdout`: cell-level 결과 (한 줄 텍스트, wrapper가 파싱)
- `<output-prefix>.parquet`: per-thread 결과 (op 단위 latency 히스토그램 포함)
- OTLP/HTTP gauge + histogram을 `--otlp-endpoint`에 전송

## 측정 흐름 (8 step)

각 transaction은 8 단계로 구성됩니다 (PER_CALL_RAW 정의):

```
1. C_OpenSession
2. C_Login (CKU_USER, CO 권한)        — KEK 사용을 위해 필요
3. C_FindObjects (BMT_KEK_AES{128,256}) — 사전 등록된 KEK 핸들 lookup
4. C_GenerateKey (CKM_AES_KEY_GEN)     — 일회성 DEK 생성
5. C_EncryptInit + C_Encrypt           — 페이로드 암호화 (선택한 mode)
6. C_DestroyObject                     — DEK 즉시 폐기
7. C_Logout
8. C_CloseSession
```

KEK reuse 모드(`PerCallOperationsCloudHsmKekReuse`와 동등)는 매 트랜잭션마다 KEK를 다시 lookup하지 않고 process 수명 동안 핸들을 유지합니다 — 측정 대상은 DEK 생성/암호화 사이클 자체.

## Multi-process 동시성

각 프로세스는 자기만의:
- PKCS#11 모듈 인스턴스 (`dlopen` per process)
- mTLS connection pool (CloudHSM Client SDK가 프로세스마다 별도 풀 생성)
- 64 thread (`pthread_create`)

→ HSM 입장에서는 N×64 client connection이 동시에 들어옵니다. cs별 saturation point를 결정하는 핵심 변수.

## OTel 익스포터 (`otel_emit.c`)

- 1초마다 `hsm_operations_total` (counter), `hsm_operation_latency_ns` (histogram), `hsm_active_workers` (gauge)를 OTLP/HTTP로 전송
- ADOT 콜렉터(`localhost:4317`)가 받아 AMP에 remote-write
- Grafana live-run 대시보드가 cell 단위 진척도와 thread 활성도를 시각화

## 종료 신호

`SIGTERM` 수신 시 모든 thread가 다음 transaction boundary에서 종료. `abort-run` Lambda가 SSM SendCommand로 `pkill -TERM -f per_call_bench`를 보냅니다 (RCA Phase D).

## 버전 fixed-pinning 정책

- 운영 중에는 binary를 **절대 hot-replace하지 말 것** — 측정 도중 swap하면 EC2 bash가 lazy-read한 offset이 어긋나 syntax error로 die할 수 있음
- 새 binary 배포 → loader-info SSM publish → 운영자가 `/runs/new`에서 새 versionId/sha256 입력 → 다음 run부터 사용

## 호환성

- CloudHSM Client SDK 5.17.x 이상 (PKCS#11 module v2.40)
- AL2023 / AL2 / Ubuntu 22.04 (glibc 2.34+)
- gcc 11+ 또는 clang 14+ (C11)
