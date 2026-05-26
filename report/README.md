# `report/` — 한국어 PDF/HTML 리포트 생성기 (Python 3.12)

측정 완료된 run의 S3 Parquet 결과물을 입력으로 받아 한국어 PDF + HTML 리포트를 생성합니다. 로더 EC2(Amazon Linux 2023)에서 실행되며, 측정이 끝나면 DDB Streams 트리거(`iac/lambda/report-trigger/`)가 자동으로 호출합니다.

## 디렉토리

```
report/
├── pyproject.toml                       Python 패키지 정의 + console-script
├── src/hsm_bmt_report/                  메인 패키지
│   ├── __main__.py                      엔트리포인트 — `python -m hsm_bmt_report --run-id ...`
│   ├── models.py                        frozen dataclass — MeasurementResult, ReportRow 등
│   ├── s3_reader.py                     S3 Parquet 로더 (boto3 + pyarrow)
│   ├── precheck_reader.py               cryptogram.json / iperf3.json / ena-baseline.json 입력
│   ├── aggregator.py                    per-proc 결과를 cell 단위로 reduce + 사이클 sweep linearity 계산
│   ├── tables.py                        throughput / latency / cluster size sweep 표 생성
│   ├── charts.py                        Matplotlib → PNG + inline SVG
│   ├── appendix.py                      한국어 부록 (TPS 환산, 운영 가이드, 사전 체크 등)
│   ├── formatting.py                    babel 기반 천 단위 구분자 + 소수점 (한국 로케일 stable)
│   ├── html_renderer.py                 Jinja2 → HTML
│   └── pdf_renderer.py                  WeasyPrint → PDF (fallback ladder 문서화)
├── templates/                           Jinja2 템플릿 (v2 슬림 — 5 섹션 + operational-guidance)
│   ├── main.html.j2                     루트
│   ├── _macros.html.j2                  공통 매크로 (숫자 포맷, 표 헤더 등)
│   └── sections/
│       ├── 00-summary.html.j2           헤드라인 + 핵심 수치
│       ├── 01-environment.html.j2       측정 환경 (HSM 버전, 클라이언트 EC2, 네트워크)
│       ├── 02-method.html.j2            측정 방법 (8 step / pthread / cooldown)
│       ├── 05-percall-throughput.html.j2 PER_CALL family throughput
│       ├── 06-percall-latency.html.j2   PER_CALL family latency
│       └── operational-guidance.html.j2 운영 가이드 (HSM-adaptive procs, 사이즈별 sweet-spot)
├── static/                              styles.css, NotoSansCJK 폰트 (사용자가 설치)
└── tests/                               pytest — formatting/aggregator/precheck 단위 테스트
```

## 의존성 설치

```bash
# Amazon Linux 2023의 기본 Python은 3.9 — 3.12 따로 설치 필요
sudo dnf install -y python3.12 python3.12-devel

# WeasyPrint가 Pango/Cairo/GDK 시스템 라이브러리에 의존
sudo dnf install -y pango cairo gdk-pixbuf2 libffi-devel

cd report
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
```

## 한국어 폰트 (1회 설정)

`static/styles.css`가 NotoSansCJKkr를 참조합니다. SIL OFL 라이선스로 자유롭게 배포 가능:

```bash
curl -L -o /tmp/noto-cjk.zip \
  'https://github.com/notofonts/noto-cjk/releases/latest/download/02_NotoSansCJK.ttc.zip'
unzip -j /tmp/noto-cjk.zip 'NotoSansCJK-Regular.ttc' -d static/
```

검증:
```bash
python -c "from weasyprint import HTML; HTML(string='<p>한국어</p>').write_pdf('/tmp/t.pdf')"
# /tmp/t.pdf 를 열어 한글 글리프가 깨지지 않고 보이는지 확인
```

## 실행

```bash
hsm-bmt-report \
  --run-id rid-20260526121825 \
  --bucket hsm-bmt-results-<account>-ap-northeast-2 \
  --output-dir ./out
# → ./out/report.html, ./out/report.pdf
```

옵션:
- `--skip-pdf` — HTML만 생성 (WeasyPrint 의존성 없이 빠름)
- `--region` — S3 버킷 리전 (기본 `ap-northeast-2`)
- `--include-precheck` — Pre-check Gate(iperf3/ena-baseline) JSON도 부록에 포함

## 테스트

```bash
pytest -v
```

커버리지:
- `aggregator.py` — per-proc reduction (sum ops, max p99, weighted mean)
- `formatting.py` — locale-stable 숫자 포맷 (시스템 locale 미의존)
- `precheck_reader.py` — NoSuchKey 와 ParseError 구분, ascending process_idx fallback
- `tables.py` — descending cluster size 정렬, errors_per_call 계산

## 자동 호출 흐름

```
[orchestrate.sh — 측정 완료]
   ↓ (DDB bmt-runs status=COMPLETED 업데이트)
[DDB Streams]
   ↓
[iac/lambda/report-trigger]
   ↓ (SSM SendCommand로 로더 EC2에 render-report.sh 실행 지시)
[로더 EC2: iac/assets/render-report.sh]
   ↓ (python -m hsm_bmt_report --run-id $RUN_ID --bucket $BUCKET --output-dir /tmp/$RUN_ID)
[이 패키지]
   ↓ (S3 reports/$RUN_ID/{report.html, report.pdf} 업로드)
[운영자가 /runs/{id}/report 페이지에서 조회]
```

자동 트리거 외에도 운영자가 수동으로 `--run-id` 만 바꿔서 다시 렌더링 가능 (template 수정 후 재발행 등).

## PDF 엔진 fallback ladder

WeasyPrint가 환경 문제로 실패할 경우의 대안:

1. **WeasyPrint** (기본) — Pango/Cairo 기반, CJK 글리프 직접 처리
2. **Asciidoctor-PDF** — HTML → AsciiDoc → PDF, Ruby 환경 필요
3. **wkhtmltopdf** — Qt 기반, headless X 필요
4. **XeLaTeX + xeCJK** — 가장 안정적이지만 LaTeX 풀 설치 필요

Day-1 검증: 운영자가 `python -m hsm_bmt_report --run-id <test-run> --output-dir /tmp/test-render`로 1페이지 한글 테스트 PDF를 만들어 글리프 확인 후 본 측정에 사용.

## Lambda 패키징 주의

이 패키지는 **Lambda 안에서 직접 호출하지 않습니다.** 측정 종료 시점에 로더 EC2에서 한 번 렌더링한 결과(`reports/{runId}/{report.html, report.pdf}`)를 S3에 올리고, Lambda(`web-api/src/report-html-redirect.ts`, `report-pdf-redirect.ts`)는 단순히 S3 presigned URL로 302 리다이렉트만 합니다. WeasyPrint는 GTK/Pango/Cairo 시스템 라이브러리 의존이라 Lambda 표준 런타임에서 동작 불가 — 컨테이너 이미지 Lambda를 쓰면 가능하지만 cold start ~5초로 비용 대비 효용이 낮음.
