from __future__ import annotations

from hsm_bmt_report.aggregator import Aggregator
from hsm_bmt_report.tables import TableRenderer


def test_throughput_v3_dimensions(synthetic_results):
    """V3 throughput table after Variant column removal (2026-05-22).

    Headers: 2 leading (Algorithm, Payload) + 5 cluster sizes = 7 columns.
    Data rows: 2 algos × 2 payloads = 4 rows.
    Synthetic fixture has both Variant A and Variant B rows for each
    (algo, payload, size); the fixture's last-write-wins iteration order
    means the table may pick whichever row sorted last for each cell.
    Either way, the cell count and dimensionality should be correct.
    """
    rows = Aggregator().by_v3(synthetic_results)
    t = TableRenderer().throughput_v3(rows)
    assert len(t.rows) == 4
    assert len(t.headers) == 7  # was 12 with VA/VB columns; now single column per size


def test_throughput_v3_table_does_not_advertise_variant_columns(synthetic_results):
    rows = Aggregator().by_v3(synthetic_results)
    t = TableRenderer().throughput_v3(rows)
    for h in t.headers:
        assert "VA" not in h and "VB" not in h
        assert "Variant" not in h


def test_throughput_per_call_dimensions(synthetic_results):
    rows = Aggregator().by_per_call(synthetic_results)
    t = TableRenderer().throughput_per_call(rows)
    # 2 algos × 5 modes × 2 payloads = 20 rows
    assert len(t.rows) == 20
    # Headers: 3 leading + 5 sizes = 8
    assert len(t.headers) == 8


def test_scalability_table_does_not_inline_formula_row(synthetic_results):
    """The 'Required HSMs = ceil(...)' formula was removed from the data
    table 2026-05-22; it now lives in §7 prose only. The table is now
    pure data: one row per cluster size."""
    rows = Aggregator().by_v3(synthetic_results)
    points = Aggregator().linearity(rows)
    t = TableRenderer().scalability(points)
    assert len(t.headers) == 5
    # Data rows: one per cluster size, no formula row
    assert len(t.rows) == 5
    for row in t.rows:
        assert row[0] != "산식"


def test_latency_v3_columns(synthetic_results):
    """V3 latency table dimensions after Variant column removal:
    rows = (algo × payload × cluster_size) = 2 × 2 × 5 = 20 unique cells."""
    rows = Aggregator().by_v3(synthetic_results)
    t = TableRenderer().latency_v3(rows)
    assert "p50 (ms)" in t.headers and "p99 (ms)" in t.headers
    assert "Variant" not in t.headers
    # Synthetic has Variant A and B per (algo, payload, size); after dropping
    # the Variant axis the table picks one row per (algo, payload, size).
    assert len(t.rows) == 20
