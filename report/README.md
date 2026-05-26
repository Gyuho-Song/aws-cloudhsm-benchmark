# `report/` — CloudHSM CloudHSM BMT Phase 1 Report Generator (Unit 4)

Python 3.12 tool that consumes Loader's S3 Parquet output and produces the **PDF + HTML report** delivered to <PARTNER> by 2026-05-21 EOD (AC-9, AC-13).

Per `aidlc-docs/construction/u4-report/functional-design/functional-design.md`.

## What's in here

```
report/
├── pyproject.toml                       Python package + console-script
├── src/hsm_bmt_report/                  Main package
│   ├── __main__.py                      `python -m hsm_bmt_report --run-id ...`
│   ├── models.py                        Frozen dataclasses (mirror Java MeasurementResult)
│   ├── s3_reader.py                     Parquet loader (boto3 + pyarrow)
│   ├── precheck_reader.py               cryptogram.json / iperf3.json / ena-baseline.json
│   ├── aggregator.py                    Per-unit results → ReportRows + linearity + Variant pairs
│   ├── tables.py                        Throughput / latency / scalability / Variant comparison tables
│   ├── charts.py                        Matplotlib → PNG + inline SVG
│   ├── appendix.py                      localized appendices (TPS guide, optimization, TDES, pre-check)
│   ├── html_renderer.py                 Jinja2 → HTML
│   └── pdf_renderer.py                  WeasyPrint → PDF (fallback ladder documented)
├── templates/                           Jinja2 templates: main + 10 sections
├── static/                              styles.css, noto-sans-cjk-kr.css
└── tests/                               pytest fixtures + 4 test modules (~20 behaviors)
```

## Setup (operator host)

```bash
# Amazon Linux 2023 default Python is 3.9; install 3.12:
sudo dnf install -y python3.12 python3.12-devel
# WeasyPrint needs Pango/Cairo:
sudo dnf install -y pango cairo gdk-pixbuf2 libffi-devel

cd report
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
```

## CJK font setup (one-time)

The `static/noto-sans-cjk-kr.css` references the OTF files at `static/NotoSansCJKkr-{Regular,Bold}.otf`. Fetch them from the Noto fonts release (SIL OFL):

```bash
curl -L -o /tmp/noto-cjk.zip 'https://github.com/notofonts/noto-cjk/releases/latest/download/02_NotoSansCJK.ttc.zip'
unzip -j /tmp/noto-cjk.zip 'NotoSansCJK-Regular.ttc' -d static/
# Or any equivalent SubsetOTF distribution providing CJK glyphs.
```

(Verification: `python -c "from weasyprint import HTML; HTML(string='<p>한국어</p>').write_pdf('/tmp/t.pdf')"` and visually confirm CJK glyphs render.)

## Run

```bash
hsm-bmt-report --run-id rid-2026-05-19 --bucket hsm-bmt-results-${ACCOUNT}-ap-northeast-2 --output-dir ./out
# → ./out/report.html and ./out/report.pdf
```

For Unit 5 web console (HTML-only, no WeasyPrint required):

```bash
hsm-bmt-report --run-id ... --bucket ... --output-dir ./out --skip-pdf
```

## Tests

```bash
pytest -v
```

Behaviors covered:
- Aggregator: 40/100/140 row counts, linearity by cluster size, Variant pairing
- Tables: V3 dimensions (4×12), per-call (20×8), scalability formula row, Variant comparison rows
- Appendix: TPS conversion worked example, FIPS 140-3 / 2024-01-01 markers, cryptogram bytes embedded
- HtmlRenderer: localized headers, section anchors, SVG inline, run_id substitution

## Fallback PDF engines (per `application-design.md` §10)

If WeasyPrint Korean rendering fails, the fallback ladder is:

1. **WeasyPrint** (default) — current implementation
2. **Asciidoctor-PDF** — alternative path; convert HTML → AsciiDoc → PDF
3. **wkhtmltopdf** — Qt-based; requires headless X
4. **LaTeX (XeLaTeX + xeCJK)** — most reliable for CJK glyphs but biggest setup

Day-1 verification (per `application-design.md` §10): operator renders a 1-page Korean test PDF and visually confirms glyphs before relying on the toolchain for the final report.

## Lambda packaging note (Unit 5) — REVISED per U4 review

Per U4 review feedback (#1, #5), **U5 does NOT call this package at request time**. Both `report.html` and `report.pdf` are pre-rendered on the operator workstation and uploaded to `s3://<bucket>/reports/{runId}/`. The U5 Lambda is just a thin S3 redirect:

```python
# pseudocode for u5 GET /reports/{id} Lambda — no Python deps from this package required
return {"statusCode": 302, "headers": {"Location": s3_presigned(f"reports/{run_id}/report.html")}}
```

If a future iteration wants runtime HTML rendering inside Lambda, recommended packaging:

- Use the AWS-managed Lambda Layer **`AWSSDKPandas-Python312`** (provides pandas + pyarrow + boto3, ~130 MB).
- Package this report tool's Python sources + Jinja2 templates + Noto Sans CJK KR static assets in a separate layer.
- DO NOT include WeasyPrint in the Lambda — it requires GTK/Pango/Cairo system libraries unavailable on the standard Python runtime. Container-image Lambda is the only viable WeasyPrint path; cold start ~5 s.
