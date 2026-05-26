"""U-CH-7: tests for the multi-proc reduction in s3_reader.reduce_multiproc."""

from __future__ import annotations

from datetime import datetime, timezone

from hsm_bmt_report.models import (
    EnaSnapshot,
    Family,
    MeasurementResult,
    Variant,
)
from hsm_bmt_report.s3_reader import reduce_multiproc

# `EnaSnapshot` import re-export for typing in helpers
__all__ = ["EnaSnapshot"]


def _ena() -> EnaSnapshot:
    return EnaSnapshot(
        captured_at=datetime(2026, 5, 19, tzinfo=timezone.utc),
        bw_in_allowance_exceeded=0,
        bw_out_allowance_exceeded=0,
        pps_allowance_exceeded=0,
        conntrack_allowance_exceeded=0,
        link_local_allowance_exceeded=0,
    )


def _proc_row(unit_id: str, ops: float, p50: int, p95: int, p99: int,
              ops_count: int, valid: bool = True, errors: int = 0,
              start_offset_s: int = 0, process_idx: str = "0",
              ena_pre: EnaSnapshot | None = None,
              ena_post: EnaSnapshot | None = None) -> MeasurementResult:
    return MeasurementResult(
        run_id="rid-20260519010000",
        unit_id=unit_id,
        family=Family.V3,
        algo="AES_256",
        mode="ECB",
        payload_bytes=1024,
        cluster_size=6,
        variant=Variant.A,
        ops_count=ops_count,
        ops_per_sec=ops,
        p50_ns=p50,
        p95_ns=p95,
        p99_ns=p99,
        error_count=errors,
        ena_pre=ena_pre or _ena(),
        ena_post=ena_post or _ena(),
        tcp_retransmit_delta=0,
        start_ts=datetime(2026, 5, 19, 12, 0, start_offset_s, tzinfo=timezone.utc),
        end_ts=datetime(2026, 5, 19, 12, 5, tzinfo=timezone.utc),
        binary_sha256="abc",
        binary_s3_version_id="v1",
        valid=valid,
        process_idx=process_idx,
    )


def _nonzero_ena() -> EnaSnapshot:
    return EnaSnapshot(
        captured_at=datetime(2026, 5, 19, tzinfo=timezone.utc),
        bw_in_allowance_exceeded=42,
        bw_out_allowance_exceeded=0,
        pps_allowance_exceeded=0,
        conntrack_allowance_exceeded=0,
        link_local_allowance_exceeded=0,
    )


def test_no_multiproc_returns_input_unchanged():
    rows = [_proc_row("v3-aes_256-1024-c6-VA", ops=10000.0, p50=1_000_000,
                       p95=2_000_000, p99=3_000_000, ops_count=3_000_000)]
    out = reduce_multiproc(rows)
    assert out == rows


def test_two_procs_collapse_to_one_row_per_unit():
    """Two per-proc rows for the same unit_id collapse into one cell row."""
    p0 = _proc_row("v3-aes_256-1024-c6-VA", ops=4000.0, p50=1_000_000,
                   p95=2_000_000, p99=3_000_000, ops_count=1_200_000)
    p1 = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_500_000,
                   p95=2_500_000, p99=4_000_000, ops_count=1_500_000,
                   start_offset_s=2)
    out = reduce_multiproc([p0, p1])
    assert len(out) == 1
    cell = out[0]
    # ops_per_sec sums (cell-aggregate)
    assert cell.ops_per_sec == 9000.0
    assert cell.ops_count == 1_200_000 + 1_500_000
    # p99 / p95 take per-proc max (worst observed)
    assert cell.p99_ns == 4_000_000
    assert cell.p95_ns == 2_500_000
    # p50 is ops-weighted mean
    expected_p50 = int((1_000_000 * 1_200_000 + 1_500_000 * 1_500_000)
                       / (1_200_000 + 1_500_000))
    assert cell.p50_ns == expected_p50


def test_invalid_proc_taints_cell_validity():
    valid = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_000_000,
                      p95=2_000_000, p99=3_000_000, ops_count=1_500_000)
    invalid = _proc_row("v3-aes_256-1024-c6-VA", ops=4000.0, p50=1_500_000,
                        p95=2_500_000, p99=4_000_000, ops_count=1_200_000,
                        valid=False, start_offset_s=1)
    out = reduce_multiproc([valid, invalid])
    assert len(out) == 1
    assert out[0].valid is False


def test_error_counts_summed_across_procs():
    p0 = _proc_row("v3-aes_256-1024-c6-VA", ops=4000.0, p50=1_000_000,
                   p95=2_000_000, p99=3_000_000, ops_count=1_200_000, errors=5)
    p1 = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_500_000,
                   p95=2_500_000, p99=4_000_000, ops_count=1_500_000, errors=3,
                   start_offset_s=1)
    out = reduce_multiproc([p0, p1])
    assert out[0].error_count == 8


def test_distinct_units_dont_get_collapsed():
    p_unit_a_p0 = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_000_000,
                             p95=2_000_000, p99=3_000_000, ops_count=1_500_000)
    p_unit_a_p1 = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_000_000,
                             p95=2_000_000, p99=3_000_000, ops_count=1_500_000,
                             start_offset_s=1)
    p_unit_b_p0 = _proc_row("v3-aes_128-1024-c6-VA", ops=6000.0, p50=900_000,
                             p95=1_800_000, p99=2_700_000, ops_count=1_800_000)
    out = reduce_multiproc([p_unit_a_p0, p_unit_a_p1, p_unit_b_p0])
    by_id = {r.unit_id: r for r in out}
    assert len(by_id) == 2
    assert by_id["v3-aes_256-1024-c6-VA"].ops_per_sec == 10000.0
    assert by_id["v3-aes_128-1024-c6-VA"].ops_per_sec == 6000.0


def test_zero_ops_count_falls_back_to_simple_mean():
    """Degenerate: every proc has zero count → per-proc p50 mean instead."""
    p0 = _proc_row("v3-aes_256-1024-c6-VA", ops=0.0, p50=1_000_000,
                   p95=2_000_000, p99=3_000_000, ops_count=0)
    p1 = _proc_row("v3-aes_256-1024-c6-VA", ops=0.0, p50=2_000_000,
                   p95=4_000_000, p99=6_000_000, ops_count=0,
                   start_offset_s=1, process_idx="1")
    out = reduce_multiproc([p0, p1])
    assert out[0].p50_ns == int((1_000_000 + 2_000_000) / 2)


# ---- G2 (sub_process_rows preservation) ----

def test_reduced_row_preserves_sub_process_rows_sorted_by_process_idx():
    p2 = _proc_row("v3-aes_256-1024-c6-VA", ops=4000.0, p50=1_000_000,
                   p95=2_000_000, p99=3_000_000, ops_count=1_200_000,
                   process_idx="2")
    p0 = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_500_000,
                   p95=2_500_000, p99=4_000_000, ops_count=1_500_000,
                   start_offset_s=2, process_idx="0")
    p1 = _proc_row("v3-aes_256-1024-c6-VA", ops=4500.0, p50=1_200_000,
                   p95=2_300_000, p99=3_500_000, ops_count=1_300_000,
                   start_offset_s=4, process_idx="1")
    out = reduce_multiproc([p2, p0, p1])
    assert len(out) == 1
    cell = out[0]
    assert cell.sub_process_count == 3
    # ascending process_idx
    assert [r.process_idx for r in cell.sub_process_rows] == ["0", "1", "2"]
    # tuple, not list — frozen-friendly
    assert isinstance(cell.sub_process_rows, tuple)


def test_single_proc_row_keeps_default_sub_process_count_one():
    rows = [_proc_row("v3-aes_256-1024-c6-VA", ops=10000.0, p50=1_000_000,
                      p95=2_000_000, p99=3_000_000, ops_count=3_000_000)]
    out = reduce_multiproc(rows)
    assert out[0].sub_process_count == 1
    assert out[0].sub_process_rows == ()


# ---- G13 (_pick_ena_source ascending process_idx + non-zero) ----

def test_reduce_ena_fallback_picks_first_nonzero_proc():
    """proc=0 has all-zero ENA (snapshot lost), proc=1 has nonzero — reduced
    row should inherit proc=1's ENA values."""
    p0 = _proc_row("v3-aes_256-1024-c6-VA", ops=4000.0, p50=1_000_000,
                   p95=2_000_000, p99=3_000_000, ops_count=1_200_000,
                   process_idx="0", ena_pre=_ena(), ena_post=_ena())
    p1 = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_500_000,
                   p95=2_500_000, p99=4_000_000, ops_count=1_500_000,
                   start_offset_s=2, process_idx="1",
                   ena_pre=_nonzero_ena(), ena_post=_ena())
    out = reduce_multiproc([p0, p1])
    assert out[0].ena_pre.bw_in_allowance_exceeded == 42


def test_reduce_ena_fallback_uses_lowest_idx_when_all_zero():
    """All procs have all-zero ENA: fallback to lowest process_idx."""
    p1 = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_500_000,
                   p95=2_500_000, p99=4_000_000, ops_count=1_500_000,
                   process_idx="1")
    p0 = _proc_row("v3-aes_256-1024-c6-VA", ops=4000.0, p50=1_000_000,
                   p95=2_000_000, p99=3_000_000, ops_count=1_200_000,
                   start_offset_s=2, process_idx="0")
    out = reduce_multiproc([p1, p0])
    # both ENA all-zero; the function still returns deterministically
    assert out[0].ena_pre.bw_in_allowance_exceeded == 0


def test_reduce_metadata_picks_lowest_process_idx_not_min_start_ts():
    """Metadata (run_id, family, etc.) should come from lowest process_idx,
    not from min(start_ts) — proc=0 may have started later than proc=1
    and we still want proc=0 as the deterministic representative."""
    p1 = _proc_row("v3-aes_256-1024-c6-VA", ops=5000.0, p50=1_500_000,
                   p95=2_500_000, p99=4_000_000, ops_count=1_500_000,
                   process_idx="1", start_offset_s=0)  # earlier start
    p0 = _proc_row("v3-aes_256-1024-c6-VA", ops=4000.0, p50=1_000_000,
                   p95=2_000_000, p99=3_000_000, ops_count=1_200_000,
                   process_idx="0", start_offset_s=10)  # later start
    out = reduce_multiproc([p1, p0])
    # process_idx="0" wins as meta despite later start_ts
    assert out[0].process_idx == "0"
