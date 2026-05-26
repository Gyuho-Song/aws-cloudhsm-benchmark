"""Shared fixtures for U4 tests."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from hsm_bmt_report.models import (
    EnaSnapshot,
    Family,
    MeasurementResult,
    Variant,
)


def _ena() -> EnaSnapshot:
    return EnaSnapshot(
        captured_at=datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc),
        bw_in_allowance_exceeded=0,
        bw_out_allowance_exceeded=0,
        pps_allowance_exceeded=0,
        conntrack_allowance_exceeded=0,
        link_local_allowance_exceeded=0,
    )


def _make_v3(algo: str, payload: int, size: int, variant: Variant, ops: float, p99_ms: float) -> MeasurementResult:
    return MeasurementResult(
        run_id="rid-test",
        unit_id=f"v3-{algo}-{payload}-c{size}-V{variant.value}",
        family=Family.V3,
        algo=algo,
        mode="ECB",
        payload_bytes=payload,
        cluster_size=size,
        variant=variant,
        ops_count=int(ops * 300),
        ops_per_sec=ops,
        p50_ns=int(p99_ms * 0.4 * 1_000_000),
        p95_ns=int(p99_ms * 0.8 * 1_000_000),
        p99_ns=int(p99_ms * 1_000_000),
        error_count=0,
        ena_pre=_ena(),
        ena_post=_ena(),
        tcp_retransmit_delta=0,
        start_ts=datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc),
        end_ts=datetime(2026, 5, 19, 12, 5, tzinfo=timezone.utc),
        binary_sha256="abc",
        binary_s3_version_id="v1",
        valid=True,
    )


def _make_pc(algo: str, mode: str, payload: int, size: int, ops: float, p99_ms: float) -> MeasurementResult:
    return MeasurementResult(
        run_id="rid-test",
        unit_id=f"pc-{algo}-{mode}-{payload}-c{size}",
        family=Family.PER_CALL,
        algo=algo,
        mode=mode,
        payload_bytes=payload,
        cluster_size=size,
        variant=Variant.NA,
        ops_count=int(ops * 300),
        ops_per_sec=ops,
        p50_ns=int(p99_ms * 0.4 * 1_000_000),
        p95_ns=int(p99_ms * 0.8 * 1_000_000),
        p99_ns=int(p99_ms * 1_000_000),
        error_count=0,
        ena_pre=_ena(),
        ena_post=_ena(),
        tcp_retransmit_delta=0,
        start_ts=datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc),
        end_ts=datetime(2026, 5, 19, 12, 5, tzinfo=timezone.utc),
        binary_sha256="abc",
        binary_s3_version_id="v1",
        valid=True,
    )


@pytest.fixture
def synthetic_results() -> list[MeasurementResult]:
    """40 V3 + 100 per-call = 140 units."""
    out: list[MeasurementResult] = []
    # V3: 2 algos × 2 payloads × 5 sizes × 2 variants
    for algo in ("AES_128", "AES_256"):
        for payload in (256, 1024):
            for size in (2, 3, 4, 5, 6):
                for variant in (Variant.A, Variant.B):
                    base_ops = 1000 * size
                    if variant == Variant.B:
                        base_ops *= 1.3  # B is faster
                    p99 = 50.0 if variant == Variant.A else 35.0
                    out.append(_make_v3(algo, payload, size, variant, base_ops, p99))
    # Per-call: 2 algos × 5 modes × 2 payloads × 5 sizes
    for algo in ("AES_128", "AES_256"):
        for mode in ("ECB", "CBC", "CTR", "GCM", "CMAC"):
            for payload in (256, 1024):
                for size in (2, 3, 4, 5, 6):
                    out.append(_make_pc(algo, mode, payload, size, 5000 * size, 8.0))
    return out
