from __future__ import annotations

from datetime import datetime, timezone

from hsm_bmt_report.appendix import AppendixBuilder
from hsm_bmt_report.models import (
    CryptogramEvidence,
    EnaBaseline,
    EnaSnapshot,
    IperfBaseline,
)


def _ena_zero():
    snap = EnaSnapshot(
        captured_at=datetime(2026, 5, 17, tzinfo=timezone.utc),
        bw_in_allowance_exceeded=0,
        bw_out_allowance_exceeded=0,
        pps_allowance_exceeded=0,
        conntrack_allowance_exceeded=0,
        link_local_allowance_exceeded=0,
    )
    return EnaBaseline(captured_at=datetime(2026, 5, 17, tzinfo=timezone.utc), snapshot=snap)


def test_conversion_guide_does_not_hardcode_calls_per_tx():
    """The previous version baked '÷ 13' into a worked example, even though
    c-native bench measures 8 steps. The fix removes any specific divisor and
    just provides the formula so operators apply their own ratio."""
    sec = AppendixBuilder().conversion_guide()
    assert "Business TPS" in sec.body_html
    assert sec.title_ko.startswith("부록 A")
    # No hardcoded "÷ 13" example shipped to customers anymore.
    assert "÷ 13" not in sec.body_html
    assert "8,000 ÷ 13" not in sec.body_html


def test_tdes_recommendation_contains_fips_and_2024_markers():
    sec = AppendixBuilder().tdes_recommendation()
    assert "FIPS 140-3" in sec.body_html
    assert "2024-01-01" in sec.body_html


def test_precheck_evidence_embeds_cryptogram_bytes():
    crypto = CryptogramEvidence(
        run_id="rid-1",
        captured_at=datetime(2026, 5, 18, tzinfo=timezone.utc),
        cmac_hex="a1b2c3d4e5f6",
        matches_expected=True,
        expected_cmac_hex="a1b2c3d4e5f6",
    )
    iperf = IperfBaseline(
        captured_at=datetime(2026, 5, 17, tzinfo=timezone.utc),
        sustained_gbps=14.5, target_gbps=15.0,
    )
    ena = _ena_zero()
    sec = AppendixBuilder().precheck_evidence(crypto, iperf, ena)
    assert "a1b2c3d4e5f6" in sec.body_html
    assert "PASS" in sec.body_html


def test_precheck_evidence_marks_each_missing_artifact_explicitly():
    """When all three precheck artifacts are absent, each sub-section must
    explicitly read MISSING — not be silently omitted."""
    sec = AppendixBuilder().precheck_evidence(None, None, None)
    assert sec.body_html.count("MISSING") >= 3


# ---- subprocess_drilldown ----

def _multiproc_synthetic():
    """Build 2 cells: one with 4 procs, one single-proc — only the multi-proc
    cell should appear in the drilldown."""
    from hsm_bmt_report.models import Family, MeasurementResult, Variant

    def ena():
        return EnaSnapshot(
            captured_at=datetime(2026, 5, 19, tzinfo=timezone.utc),
            bw_in_allowance_exceeded=0, bw_out_allowance_exceeded=0,
            pps_allowance_exceeded=0, conntrack_allowance_exceeded=0,
            link_local_allowance_exceeded=0,
        )

    def proc(unit_id, family, algo, mode, payload, cs, variant, idx, ops, p99):
        return MeasurementResult(
            run_id="rid-test", unit_id=unit_id, family=family, algo=algo, mode=mode,
            payload_bytes=payload, cluster_size=cs, variant=variant,
            ops_count=int(ops * 300), ops_per_sec=ops,
            p50_ns=p99 * 400_000, p95_ns=p99 * 800_000, p99_ns=p99 * 1_000_000,
            error_count=2 if idx == "1" else 0,
            ena_pre=ena(), ena_post=ena(), tcp_retransmit_delta=0,
            start_ts=datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc),
            end_ts=datetime(2026, 5, 19, 12, 5, tzinfo=timezone.utc),
            binary_sha256="abc", binary_s3_version_id="v1",
            valid=True, process_idx=idx,
        )

    sub_rows = tuple(
        proc("v3-256-c6-VA", Family.V3, "AES_256", "ECB", 256, 6, Variant.A,
             str(i), ops=4000.0 + i * 100, p99=50)
        for i in range(4)
    )
    multi = proc("v3-256-c6-VA", Family.V3, "AES_256", "ECB", 256, 6, Variant.A,
                 "0", ops=16000.0, p99=50)
    multi = MeasurementResult(
        **{**multi.__dict__, "sub_process_count": 4, "sub_process_rows": sub_rows},
    )
    single = proc("v3-1024-c6-VA", Family.V3, "AES_256", "ECB", 1024, 6, Variant.A,
                  "0", ops=3500.0, p99=80)
    return [multi, single]


def test_subprocess_drilldown_shows_only_multi_proc_cells():
    sec = AppendixBuilder().subprocess_drilldown(_multiproc_synthetic())
    assert sec.title_ko.startswith("부록 D")
    assert "AES_256" in sec.body_html
    assert "4 procs" in sec.body_html
    # single-proc cell NOT rendered into drilldown table
    assert "1024B" not in sec.body_html
    for idx in ("0", "1", "2", "3"):
        assert f"<td>{idx}</td>" in sec.body_html


def test_subprocess_drilldown_renders_latency_in_milliseconds():
    """Earlier the drilldown showed p50/p95/p99 in nanoseconds (with grouping
    separators) — inconsistent with the rest of the report which is ms.
    Fixed 2026-05-22: drilldown now shows ms with 2 decimals."""
    body = AppendixBuilder().subprocess_drilldown(_multiproc_synthetic()).body_html
    for header in ("p50 (ms)", "p95 (ms)", "p99 (ms)"):
        assert header in body
    # No "(ns)" headers should remain.
    assert "p50 (ns)" not in body
    assert "p95 (ns)" not in body
    assert "p99 (ns)" not in body


def test_subprocess_drilldown_rows_sorted_ascending_by_process_idx():
    body = AppendixBuilder().subprocess_drilldown(_multiproc_synthetic()).body_html
    pos0, pos1, pos2, pos3 = (body.find(f"<td>{i}</td>") for i in ("0", "1", "2", "3"))
    assert pos0 < pos1 < pos2 < pos3


def test_subprocess_drilldown_empty_when_only_single_proc():
    """All cells procs=1 → friendly placeholder, no tables."""
    cells = _multiproc_synthetic()
    single_only = [r for r in cells if r.sub_process_count == 1]
    sec = AppendixBuilder().subprocess_drilldown(single_only)
    assert "<table>" not in sec.body_html
    assert "procs=1" in sec.body_html
