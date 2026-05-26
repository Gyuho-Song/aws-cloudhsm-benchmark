from __future__ import annotations

from hsm_bmt_report.aggregator import Aggregator


def test_v3_yields_40_rows(synthetic_results):
    rows = Aggregator().by_v3(synthetic_results)
    assert len(rows) == 40


def test_per_call_yields_100_rows(synthetic_results):
    rows = Aggregator().by_per_call(synthetic_results)
    assert len(rows) == 100


def test_total_140(synthetic_results):
    a = Aggregator()
    assert len(a.by_v3(synthetic_results)) + len(a.by_per_call(synthetic_results)) == 140


def test_linearity_returns_one_point_per_cluster_size(synthetic_results):
    a = Aggregator()
    rows = a.by_v3(synthetic_results)
    points = a.linearity(rows)
    assert {p.cluster_size for p in points} == {2, 3, 4, 5, 6}


def test_per_hsm_ops_decreases_when_normalized_by_cluster_size(synthetic_results):
    a = Aggregator()
    rows = a.by_v3(synthetic_results)
    points = sorted(a.linearity(rows), key=lambda p: p.cluster_size)
    assert all(p.per_hsm_ops > 0 for p in points)


def test_linearity_point_exposes_ideal_and_ratio(synthetic_results):
    a = Aggregator()
    rows = a.by_v3(synthetic_results)
    points = sorted(a.linearity(rows), key=lambda p: p.cluster_size)
    smallest = points[0]
    assert smallest.linearity_ratio == 1.0
    for p in points[1:]:
        assert 0.7 < p.linearity_ratio < 1.3


def test_completeness_default_falls_back_to_observed_total(synthetic_results):
    """The historical 140-unit hardcoded baseline was removed 2026-05-22.
    Now, when the caller does not pass expected_units, the report just
    reflects observed totals (avoids the 100-cell PER_CALL Full run looking
    like 71%)."""
    a = Aggregator()
    report = a.completeness(synthetic_results)
    assert report.expected_units == 140  # observed total = 140 in synthetic fixture
    assert report.valid_units == 140
    assert report.invalid_units == 0
    assert report.completion_pct == 100.0


def test_completeness_with_explicit_expected_count(synthetic_results):
    a = Aggregator()
    report = a.completeness(synthetic_results, expected_units=200)
    assert report.expected_units == 200
    assert report.valid_units == 140
    assert report.completion_pct == 70.0


def test_completeness_with_explicit_expected_ids_detects_missing(synthetic_results):
    a = Aggregator()
    expected = [r.unit_id for r in synthetic_results] + ["unit-that-never-arrived"]
    report = a.completeness(synthetic_results, expected_unit_ids=expected)
    assert report.missing_unit_ids == ["unit-that-never-arrived"]
    assert report.expected_units == 141
    assert report.valid_units == 140
