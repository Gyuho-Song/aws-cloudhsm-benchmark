"""Generate a synthetic Parquet fixture matching the Loader (Unit 2) output schema.

Produces:
  tests/fixtures/synthetic-results.parquet (140 rows)

Run once during repo bootstrap; commit the resulting Parquet so CI does not need
pyarrow at run time. Re-run only when the schema changes.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError:
    raise SystemExit("pyarrow required to regenerate fixture: pip install pyarrow")

OUT = Path(__file__).parent / "synthetic-results.parquet"
RUN_ID = "rid-synthetic"
START = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)


def _ena_zero(captured_at: datetime) -> dict[str, object]:
    return {
        "captured_at": captured_at,
        "bw_in_allowance_exceeded": 0,
        "bw_out_allowance_exceeded": 0,
        "pps_allowance_exceeded": 0,
        "conntrack_allowance_exceeded": 0,
        "link_local_allowance_exceeded": 0,
    }


def _row(family: str, algo: str, mode: str, payload: int, size: int, variant: str) -> dict[str, object]:
    rng = random.Random(hash((family, algo, mode, payload, size, variant)) & 0xFFFFFFFF)
    base_ops = 1000.0 * size if family == "V3" else 5000.0 * size
    if variant == "B":
        base_ops *= 1.30
    ops_per_sec = base_ops * rng.uniform(0.95, 1.05)
    p99_ms = (50.0 if variant == "A" else 35.0) * rng.uniform(0.9, 1.1)
    if family == "PER_CALL":
        p99_ms = 8.0 * rng.uniform(0.9, 1.1)
    p50 = int(p99_ms * 0.4 * 1_000_000)
    p95 = int(p99_ms * 0.8 * 1_000_000)
    p99 = int(p99_ms * 1_000_000)
    start = START + timedelta(minutes=rng.randint(0, 100))
    end = start + timedelta(minutes=5)
    return {
        "run_id": RUN_ID,
        "unit_id": f"{family.lower()}-{algo.lower()}-{mode.lower()}-{payload}-c{size}-V{variant}",
        "family": family,
        "algo": algo,
        "mode": mode,
        "payload_bytes": payload,
        "cluster_size": size,
        "variant": variant,
        "ops_count": int(ops_per_sec * 300),
        "ops_per_sec": ops_per_sec,
        "p50_ns": p50,
        "p95_ns": p95,
        "p99_ns": p99,
        "error_count": 0,
        "tcp_retransmit_delta": 0,
        "start_ts": start,
        "end_ts": end,
        "binary_sha256": "synthetic-sha256",
        "binary_s3_version_id": "vSynth",
        "valid": True,
        "invalid_reason": None,
        "per_call_stats": [
            {"step": "OPEN_SESSION", "count": 1000, "p50_ns": 100_000, "p95_ns": 200_000, "p99_ns": 300_000, "max_ns": 500_000},
            {"step": "SIGN_CMAC", "count": 1000, "p50_ns": 200_000, "p95_ns": 400_000, "p99_ns": 600_000, "max_ns": 900_000},
        ],
        "error_counts": [{"error_class": "UNKNOWN", "count": 0}],
        "ena_pre_captured_at": _ena_zero(start)["captured_at"],
        "ena_pre_bw_in": 0,
        "ena_pre_bw_out": 0,
        "ena_pre_pps": 0,
        "ena_pre_conntrack": 0,
        "ena_pre_linklocal": 0,
        "ena_post_captured_at": _ena_zero(end)["captured_at"],
        "ena_post_bw_in": 0,
        "ena_post_bw_out": 0,
        "ena_post_pps": 0,
        "ena_post_conntrack": 0,
        "ena_post_linklocal": 0,
    }


def build_rows() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for algo in ("AES_128", "AES_256"):
        for payload in (256, 1024):
            for size in (2, 3, 4, 5, 6):
                for variant in ("A", "B"):
                    rows.append(_row("V3", algo, "ECB", payload, size, variant))
    for algo in ("AES_128", "AES_256"):
        for mode in ("ECB", "CBC", "CTR", "GCM", "CMAC"):
            for payload in (256, 1024):
                for size in (2, 3, 4, 5, 6):
                    rows.append(_row("PER_CALL", algo, mode, payload, size, "NA"))
    return rows


def main() -> None:
    rows = build_rows()
    table = pa.Table.from_pylist(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, OUT)
    print(f"wrote {OUT} with {len(rows)} rows")


if __name__ == "__main__":
    main()
