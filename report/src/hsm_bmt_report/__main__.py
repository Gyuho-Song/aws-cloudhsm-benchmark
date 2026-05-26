"""Report generator entry point — HOS-Step13 v2 (HARD-only scenarios).

  python -m hsm_bmt_report --run-id <id> --bucket <b>

The v2 report is intentionally narrow:

  Cover  → Run id / scenario / measurement window
  §1     → 핵심 결과   (cluster-size mean / ratio / peak)
  §2     → 측정 환경    (region, EC2, HSM, SDK, binary sha256)
  §3     → 측정 방법    (matrix axes, cell duration, scale mechanism)
  §4     → 측정 결과 상세 (throughput / p99 / errors grids)
  §5     → 운영 가이드   (BizTPS, HSM 권장, 동시성 권장)

Removed (vs the V3-era pre-HOS report): summary headline, completeness %,
V3 tables/charts, scalability table, network evidence, all 5 appendices
(conversion guide / V3 throughput ceiling / TDES recommendation /
precheck evidence / subprocess drilldown). Each was useful at some point
but is noise for the HARD-only customer-handover audience.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3

from .aggregator import Aggregator
from .html_renderer import HtmlRenderer
from .models import (
    CoreResults,
    Family,
    MeasurementResult,
    MethodContext,
    OperationalGuidance,
    ReportContext,
    RuntimeContext,
    Table,
)
from .pdf_renderer import PdfRenderer
from .s3_reader import S3DataReader
from .tables import TableRenderer


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="hsm-bmt-report")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--output-dir", default="./out")
    parser.add_argument("--skip-pdf", action="store_true",
                        help="Render HTML only (used by Lambda where WeasyPrint isn't packaged)")
    parser.add_argument("--runs-table", default=os.environ.get("RUNS_TABLE", "bmt-runs"),
                        help="DDB table name for run rows (matrixSubset, totalUnits).")
    args = parser.parse_args(argv)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    run_meta = _load_run_meta(args.runs_table, args.run_id)
    runtime = _runtime_context(run_meta)
    method = _method_context(runtime, run_meta)

    s3 = S3DataReader(bucket=args.bucket, run_id=args.run_id)
    results = s3.load_all()

    agg = Aggregator()
    pc_rows = agg.by_per_call(results)
    cluster_aggs = agg.cluster_size_aggregates(pc_rows)

    tr = TableRenderer()
    desired_size = _desired_size_from(run_meta, cluster_aggs)

    matrix = (run_meta or {}).get("matrixSubset") or {}
    cluster_sweep = sorted({a.cluster_size for a in cluster_aggs}, reverse=True) or list(
        matrix.get("clusterSizes") or [6]
    )

    total_cells = len(pc_rows)
    total_errors = sum(r.error_count for r in pc_rows)
    total_transactions = sum(int(r.ops_count) for r in results if r.valid)

    core = CoreResults(
        aggregates=cluster_aggs,
        desired_size=desired_size,
        total_cells=total_cells,
        total_errors=total_errors,
        total_transactions=total_transactions,
        measurement_seconds_per_cell=method.steady_s,
    )

    guidance = _operational_guidance(cluster_aggs, desired_size)

    binary_sha256 = (run_meta or {}).get("expectedLoaderSha256", "—")
    binary_version_id = (run_meta or {}).get("expectedLoaderVersionId", "—")
    started_at = _parse_iso((run_meta or {}).get("startedAt"))
    completed_at = _parse_iso((run_meta or {}).get("completedAt"))

    ctx = ReportContext(
        run_id=args.run_id,
        generated_at=datetime.now(timezone.utc),
        runtime=runtime,
        method=method,
        core_results=core,
        per_call_throughput_table=tr.throughput_per_call(pc_rows),
        per_call_latency_table=tr.latency_per_call(pc_rows),
        per_call_error_table=tr.errors_per_call(pc_rows),
        operational_guidance=guidance,
        binary_sha256=binary_sha256,
        binary_version_id=binary_version_id,
        started_at=started_at,
        completed_at=completed_at,
        cluster_size_sweep=list(cluster_sweep),
    )

    # Bonus: §1's core_results table is used by the template too.
    ctx_with_core_table = _attach_core_table(ctx, tr.core_results(cluster_aggs, desired_size))

    html = HtmlRenderer().render(ctx_with_core_table)
    html_path = out_dir / "report.html"
    html_path.write_text(html, encoding="utf-8")

    if not args.skip_pdf:
        PdfRenderer(base_url=Path(__file__).parent.parent.parent).render(html, out_dir / "report.pdf")

    print(f"Generated: {html_path}{'' if args.skip_pdf else ', ' + str(out_dir / 'report.pdf')}")
    return 0


def _attach_core_table(ctx: ReportContext, core_table: Table) -> Any:
    """Wrap ctx so the template can read both the structured CoreResults
    and a pre-rendered Table for the §1 grid. Avoids changing the
    @dataclass(frozen=True) signature for one field used only by the
    template layer."""
    class _Wrapped:
        def __init__(self, inner: ReportContext, t: Table) -> None:
            self.__dict__.update(inner.__dict__)
            self.core_results_table = t
    return _Wrapped(ctx, core_table)


def _operational_guidance(cluster_aggs, desired_size: int) -> OperationalGuidance:
    """Derive §5 운영 가이드 numbers from the actual measurement so they
    self-update if a new run shifts the curve. Concurrency recommendations
    use the HSM-adaptive procs × 64 thread sweet-spots from the saturation
    sweep that produced the matrixSubset in the first place."""
    by_size = {a.cluster_size: a for a in cluster_aggs}
    base = by_size.get(desired_size)
    biztps_examples: list[tuple[str, str]] = []
    if base is not None:
        biztps_examples = [
            (f"cs={desired_size}, 1 HSM call/tx", f"{base.mean_ops_per_sec:,.0f} BizTPS"),
            (f"cs={desired_size}, 2 HSM call/tx", f"{base.mean_ops_per_sec / 2:,.0f} BizTPS"),
            (f"cs={desired_size}, 3 HSM call/tx", f"{base.mean_ops_per_sec / 3:,.0f} BizTPS"),
        ]

    hsm_recommendations = [
        ("Production 정상", f"{desired_size}", "충분한 헤드룸 + AZ 다중화"),
        ("HSM 1~2대 장애", f"{max(desired_size - 2, 2)}~{desired_size - 1}", "처리량 67~84 % 유지"),
        ("비상 운영", "2~3", "SLA 재평가 필요"),
    ]

    # Concurrency: procs × 64 thread = total concurrent in flight.
    concurrency_recommendations = [
        (6, 12 * 64),
        (5, 12 * 64),
        (4, 10 * 64),
        (3, 8 * 64),
        (2, 6 * 64),
    ]
    return OperationalGuidance(
        biztps_examples=biztps_examples,
        hsm_recommendations=hsm_recommendations,
        concurrency_recommendations=concurrency_recommendations,
    )


def _desired_size_from(run_meta: dict[str, Any] | None, cluster_aggs) -> int:
    """Pick the baseline cluster size for §1 ratios.

    Preference order:
      1. matrixSubset.clusterSizes max — the size operators 'started at'
      2. fallback: max observed size in the run
      3. fallback fallback: 6 (typical desired-hsm-count)
    """
    if run_meta:
        sizes = (run_meta.get("matrixSubset") or {}).get("clusterSizes")
        if isinstance(sizes, list) and sizes:
            try:
                return max(int(x) for x in sizes)
            except (TypeError, ValueError):
                pass
    if cluster_aggs:
        return max(a.cluster_size for a in cluster_aggs)
    return 6


def _parse_iso(s: Any) -> datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _load_run_meta(table_name: str, run_id: str) -> dict[str, Any] | None:
    try:
        # AWS_REGION env is set by the loader's instance metadata; fall back
        # to the home region so dev shells without an env still resolve.
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "ap-northeast-2"
        ddb = boto3.client("dynamodb", region_name=region)
        out = ddb.get_item(TableName=table_name, Key={"runId": {"S": run_id}})
    except Exception:
        return None
    item = out.get("Item")
    if not item:
        return None
    return _unmarshal(item)


def _unmarshal(d: Any) -> Any:
    if not isinstance(d, dict):
        return d
    if len(d) == 1 and next(iter(d)) in {"S", "N", "BOOL", "L", "M", "NULL", "SS", "NS"}:
        kind, val = next(iter(d.items()))
        if kind == "S":    return val
        if kind == "N":    return float(val) if "." in val else int(val)
        if kind == "BOOL": return val
        if kind == "NULL": return None
        if kind == "L":    return [_unmarshal(x) for x in val]
        if kind == "M":    return {k: _unmarshal(v) for k, v in val.items()}
        if kind == "SS":   return list(val)
        if kind == "NS":   return [float(x) if "." in x else int(x) for x in val]
    return {k: _unmarshal(v) for k, v in d.items()}


def _runtime_context(run_meta: dict[str, Any] | None) -> RuntimeContext:
    runner = "c-native-multiproc"
    if run_meta:
        ms = run_meta.get("matrixSubset") or {}
        runner = ms.get("runner") or runner
    kind = "c-native" if runner.startswith("c-native") else "java"
    return RuntimeContext(runner=runner, kind=kind)


def _method_context(runtime: RuntimeContext, run_meta: dict[str, Any] | None) -> MethodContext:
    """Method-section facts. HOS-Step13 only renders the c-native path
    (HARD-only scenarios use c-native-multiproc); java branch retained for
    legacy DDB rows that may pre-date HOS."""
    if runtime.is_c_native:
        v3_steps = 8
        v3_steps_note_ko = ""  # V3 retired — note unused in v2 templates
        worker_desc = (
            "C native bench (per_call_bench)는 운영체제 스레드(libpthread) 기반 워커를 "
            "사용합니다. cluster size 별 sweet-spot procs 적용 "
            "(c=6→p=12, c=5→p=12, c=4→p=10, c=3→p=8, c=2→p=6); 각 process는 thread=64."
        )
    else:
        v3_steps = 13
        v3_steps_note_ko = ""
        worker_desc = "Java 21 동시 워커 (시나리오별 워커 수 가변)."

    return MethodContext(
        v3_steps_per_tx=v3_steps,
        v3_steps_note_ko=v3_steps_note_ko,
        per_call_modes_ko="ECB · CBC · CTR · GCM · CMAC",
        warmup_s=0,
        steady_s=360,
        cell_cooldown_s=30,
        cluster_cooldown_s=300,
        worker_description_ko=worker_desc,
    )


if __name__ == "__main__":
    sys.exit(main())
