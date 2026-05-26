"""Aggregator — converts MeasurementResult records into ReportRows + linearity points."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable

from .models import (
    ClusterAggregate,
    CompletenessReport,
    Family,
    LinearityPoint,
    MeasurementResult,
    ReportRow,
)


class Aggregator:
    @staticmethod
    def _ns_to_ms(ns: int) -> float:
        return ns / 1_000_000.0

    def by_v3(self, results: Iterable[MeasurementResult]) -> list[ReportRow]:
        return [self._to_row(r) for r in results if r.family == Family.V3 and r.valid]

    def by_per_call(self, results: Iterable[MeasurementResult]) -> list[ReportRow]:
        # PER_CALL_RAW (KEK-reuse, C native or Java KekReuse) folds into the
        # per-call section of the report. Section heading + dimensionality
        # (algo × mode × payload × cluster_size) are identical to the legacy
        # PER_CALL family — the difference is only in implementation path.
        return [
            self._to_row(r)
            for r in results
            if r.family in (Family.PER_CALL, Family.PER_CALL_RAW) and r.valid
        ]

    def linearity(self, rows: Iterable[ReportRow]) -> list[LinearityPoint]:
        """Aggregates rows by cluster size into LinearityPoints.

        ``ideal_linear_ops_per_sec`` uses ``per_hsm`` of the smallest cluster size
        as the baseline; ideal at size N = ``baseline_per_hsm × N``.
        """
        bucket: dict[int, list[float]] = defaultdict(list)
        for r in rows:
            bucket[r.cluster_size].append(r.ops_per_sec)
        means: list[tuple[int, float]] = sorted(
            (size, sum(vs) / len(vs)) for size, vs in bucket.items()
        )
        if not means:
            return []
        baseline_size, baseline_ops = means[0]
        baseline_per_hsm = baseline_ops / baseline_size if baseline_size else 0.0
        return [
            LinearityPoint(
                cluster_size=size,
                measured_ops_per_sec=ops,
                ideal_linear_ops_per_sec=baseline_per_hsm * size,
            )
            for size, ops in means
        ]

    def completeness(
        self,
        results: Iterable[MeasurementResult],
        expected_units: int | None = None,
        expected_unit_ids: Iterable[str] | None = None,
    ) -> CompletenessReport:
        """Reports how many of the expected units actually arrived and were valid.

        Caller supplies the scenario-specific ``expected_units`` (e.g., from the
        DDB run row's ``totalUnits``). When neither ``expected_units`` nor
        ``expected_unit_ids`` is provided, the expected count falls back to the
        observed total — i.e., we cannot judge completeness, but at least we
        avoid the historical bug where a static 140-unit baseline made every
        partial-scenario run look incomplete.
        """
        results_list = list(results)
        valid = sum(1 for r in results_list if r.valid)
        invalid = sum(1 for r in results_list if not r.valid)
        if expected_unit_ids is not None:
            expected = list(expected_unit_ids)
            seen = {r.unit_id for r in results_list}
            return CompletenessReport(
                expected_units=len(expected),
                valid_units=valid,
                invalid_units=invalid,
                missing_unit_ids=[uid for uid in expected if uid not in seen],
            )
        if expected_units is None:
            expected_units = valid + invalid
        return CompletenessReport(
            expected_units=expected_units,
            valid_units=valid,
            invalid_units=invalid,
            missing_unit_ids=[],
        )

    def cluster_size_aggregates(self, rows: Iterable[ReportRow]) -> list[ClusterAggregate]:
        """HOS-Step13 §1: per-cluster-size mean / peak (with peak cell label).

        Used by the §1 "핵심 결과" table (mean ops/s, cs=N/cs=desired ratio,
        peak ops/s + the algo/mode/payload that produced the peak).
        """
        bucket: dict[int, list[ReportRow]] = defaultdict(list)
        for r in rows:
            bucket[r.cluster_size].append(r)
        out: list[ClusterAggregate] = []
        for size in sorted(bucket.keys(), reverse=True):
            cells = bucket[size]
            if not cells:
                continue
            ops_values = [c.ops_per_sec for c in cells]
            peak_row = max(cells, key=lambda c: c.ops_per_sec)
            peak_label = (
                f"{peak_row.algo} {peak_row.mode or ''} {peak_row.payload_bytes}B"
            ).strip()
            out.append(ClusterAggregate(
                cluster_size=size,
                cell_count=len(cells),
                mean_ops_per_sec=sum(ops_values) / len(ops_values),
                peak_ops_per_sec=peak_row.ops_per_sec,
                peak_label=peak_label,
            ))
        return out

    def _to_row(self, r: MeasurementResult) -> ReportRow:
        is_per_call = r.family in (Family.PER_CALL, Family.PER_CALL_RAW)
        return ReportRow(
            family=r.family,
            algo=r.algo,
            mode=r.mode if is_per_call else None,
            payload_bytes=r.payload_bytes,
            cluster_size=r.cluster_size,
            ops_per_sec=r.ops_per_sec,
            p50_ms=self._ns_to_ms(r.p50_ns),
            p95_ms=self._ns_to_ms(r.p95_ns),
            p99_ms=self._ns_to_ms(r.p99_ns),
            error_count=r.error_count,
            valid=r.valid,
        )
