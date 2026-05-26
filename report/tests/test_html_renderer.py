"""Smoke tests for HOS-Step13 v2 HtmlRenderer output.

The pre-HOS report had ten-section TOC + 5 appendices. The v2 report has
five sections (cover + §1 핵심 결과 / §2 환경 / §3 방법 / §4 결과 / §5
운영 가이드) and zero appendices.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from hsm_bmt_report.aggregator import Aggregator
from hsm_bmt_report.html_renderer import HtmlRenderer
from hsm_bmt_report.models import (
    CoreResults,
    MethodContext,
    OperationalGuidance,
    ReportContext,
    RuntimeContext,
)
from hsm_bmt_report.tables import TableRenderer

TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "templates"


def _build_context(synthetic_results):
    a = Aggregator()
    pc_rows = a.by_per_call(synthetic_results)
    aggs = a.cluster_size_aggregates(pc_rows)
    tr = TableRenderer()
    desired = max((s.cluster_size for s in aggs), default=6)

    core = CoreResults(
        aggregates=aggs,
        desired_size=desired,
        total_cells=len(pc_rows),
        total_errors=sum(r.error_count for r in pc_rows),
        total_transactions=sum(int(r.ops_per_sec * 360) for r in pc_rows),
        measurement_seconds_per_cell=360,
    )
    guidance = OperationalGuidance(
        biztps_examples=[("cs=6 · 1 call/tx", "1,234 BizTPS")],
        hsm_recommendations=[("Production 정상", "6", "헤드룸 충분")],
        concurrency_recommendations=[(6, 768), (5, 768), (4, 640), (3, 512), (2, 384)],
    )

    ctx = ReportContext(
        run_id="rid-test",
        generated_at=datetime(2026, 5, 25, 9, tzinfo=timezone.utc),
        runtime=RuntimeContext(runner="c-native-multiproc", kind="c-native"),
        method=MethodContext(
            v3_steps_per_tx=8,
            v3_steps_note_ko="",
            per_call_modes_ko="ECB · CBC · CTR · GCM · CMAC",
            warmup_s=0,
            steady_s=360,
            cell_cooldown_s=30,
            cluster_cooldown_s=300,
            worker_description_ko="C bench pthread 기반 워커.",
        ),
        core_results=core,
        per_call_throughput_table=tr.throughput_per_call(pc_rows),
        per_call_latency_table=tr.latency_per_call(pc_rows),
        per_call_error_table=tr.errors_per_call(pc_rows),
        operational_guidance=guidance,
        binary_sha256="fb9adda…",
        binary_version_id="6c.cxOt8…",
        started_at=datetime(2026, 5, 25, 5, 2, tzinfo=timezone.utc),
        completed_at=datetime(2026, 5, 25, 17, 7, tzinfo=timezone.utc),
        cluster_size_sweep=[6, 5, 4, 3, 2],
    )
    # __main__ wraps ctx with core_results_table for the §1 template; mirror
    # that here.
    class _Wrapped:
        def __init__(self, inner, t):
            self.__dict__.update(inner.__dict__)
            self.core_results_table = t
    return _Wrapped(ctx, tr.core_results(aggs, desired))


def test_html_contains_v2_section_headers(synthetic_results):
    ctx = _build_context(synthetic_results)
    html = HtmlRenderer(template_dir=TEMPLATE_DIR).render(ctx)
    for header in ["핵심 결과", "측정 환경", "측정 방법", "운영 가이드"]:
        assert header in html, f"missing v2 section header: {header}"


def test_html_drops_retired_sections(synthetic_results):
    ctx = _build_context(synthetic_results)
    html = HtmlRenderer(template_dir=TEMPLATE_DIR).render(ctx)
    for forbidden in ["V3 시퀀스 처리량", "확장성 분석", "네트워크 병목", "TDES", "프로세스별"]:
        assert forbidden not in html, f"retired section leaked into v2 render: {forbidden}"


def test_html_does_not_mention_variant_b(synthetic_results):
    ctx = _build_context(synthetic_results)
    html = HtmlRenderer(template_dir=TEMPLATE_DIR).render(ctx)
    assert "Variant B" not in html


def test_html_does_not_mention_jvm_when_c_native(synthetic_results):
    ctx = _build_context(synthetic_results)
    html = HtmlRenderer(template_dir=TEMPLATE_DIR).render(ctx)
    for forbidden in ["Virtual Threads", "ZGC", "JCE Provider"]:
        assert forbidden not in html


def test_html_includes_run_id(synthetic_results):
    ctx = _build_context(synthetic_results)
    html = HtmlRenderer(template_dir=TEMPLATE_DIR).render(ctx)
    assert "rid-test" in html


def test_html_includes_section_anchors(synthetic_results):
    ctx = _build_context(synthetic_results)
    html = HtmlRenderer(template_dir=TEMPLATE_DIR).render(ctx)
    for anchor_id in [
        "summary", "environment", "method",
        "per-call-throughput", "per-call-latency", "operational-guidance",
    ]:
        assert f'id="{anchor_id}"' in html
