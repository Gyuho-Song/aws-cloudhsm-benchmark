"""TableRenderer — builds throughput / latency / scalability tables with Korean captions."""

from __future__ import annotations

from collections.abc import Iterable

from .models import (
    Family,
    LinearityPoint,
    ReportRow,
    Table,
)

# HOS-Step13: tables render the size sweep in DESCENDING order (cs=6 first
# → cs=2 last), matching the manual report v2 layout. The previous
# ascending layout was inherited from the V3 era and is kept inverted in
# legacy tests via a constant.
CLUSTER_SIZES: tuple[int, ...] = (6, 5, 4, 3, 2)


class TableRenderer:
    def throughput_v3(self, rows: Iterable[ReportRow]) -> Table:
        """V3 family: rows = (algo × payload), columns = cluster_size.

        Production V3 scenarios all run Variant A only — no per-Variant column
        split is rendered. (Historical Variant B columns were removed 2026-05-22
        when the Variant A vs B section was retired.)
        """
        v3_rows = [r for r in rows if r.family == Family.V3]
        keys = sorted({(r.algo, r.payload_bytes) for r in v3_rows})
        headers = ["Algorithm", "Payload"] + [f"size={s} (ops/s)" for s in CLUSTER_SIZES]
        body: list[list[str]] = []
        for algo, payload in keys:
            cells = [algo, str(payload)]
            for size in CLUSTER_SIZES:
                match = [
                    r for r in v3_rows
                    if r.algo == algo and r.payload_bytes == payload
                    and r.cluster_size == size
                ]
                cells.append(f"{match[0].ops_per_sec:,.0f}" if match else "-")
            body.append(cells)
        return Table(
            caption="V3 시퀀스 처리량 (ops/sec) — Algorithm × Payload × Cluster size",
            headers=headers,
            rows=body,
        )

    def throughput_per_call(self, rows: Iterable[ReportRow]) -> Table:
        """Per-call: rows = (algo × mode × payload), columns = cluster_size."""
        pc_rows = [r for r in rows if r.family in (Family.PER_CALL, Family.PER_CALL_RAW)]
        keys = sorted({(r.algo, r.mode or "", r.payload_bytes) for r in pc_rows})
        headers = ["Algorithm", "Mode", "Payload"] + [f"cs={s}" for s in CLUSTER_SIZES]
        body: list[list[str]] = []
        for algo, mode, payload in keys:
            cells = [algo, mode, str(payload)]
            for size in CLUSTER_SIZES:
                match = [
                    r for r in pc_rows
                    if r.algo == algo and (r.mode or "") == mode
                    and r.payload_bytes == payload and r.cluster_size == size
                ]
                cells.append(f"{match[0].ops_per_sec:,.0f}" if match else "-")
            body.append(cells)
        return Table(
            caption="Per-call 처리량 (ops/sec) — Algorithm × Mode × Payload × Cluster size",
            headers=headers,
            rows=body,
        )

    def latency_v3(self, rows: Iterable[ReportRow]) -> Table:
        v3_rows = [r for r in rows if r.family == Family.V3]
        keys = sorted({(r.algo, r.payload_bytes, r.cluster_size) for r in v3_rows})
        body: list[list[str]] = []
        for algo, payload, size in keys:
            match = [
                r for r in v3_rows
                if r.algo == algo and r.payload_bytes == payload
                and r.cluster_size == size
            ]
            if not match:
                continue
            r = match[0]
            body.append([
                algo, str(payload), str(size),
                f"{r.p50_ms:.2f}", f"{r.p95_ms:.2f}", f"{r.p99_ms:.2f}",
            ])
        return Table(
            caption="V3 시퀀스 지연 (ms) — p50 / p95 / p99",
            headers=["Algorithm", "Payload", "Cluster size", "p50 (ms)", "p95 (ms)", "p99 (ms)"],
            rows=body,
        )

    def latency_per_call(self, rows: Iterable[ReportRow]) -> Table:
        """HOS-Step13: p99 grid laid out (algo × mode × payload) × cluster_size,
        matching the manual report v2 §3.2 format (one row per cell triplet,
        cs columns descending).
        """
        pc_rows = [r for r in rows if r.family in (Family.PER_CALL, Family.PER_CALL_RAW)]
        keys = sorted({(r.algo, r.mode or "", r.payload_bytes) for r in pc_rows})
        headers = ["Algorithm", "Mode", "Payload"] + [f"cs={s}" for s in CLUSTER_SIZES]
        body: list[list[str]] = []
        for algo, mode, payload in keys:
            cells = [algo, mode, str(payload)]
            for size in CLUSTER_SIZES:
                match = [
                    r for r in pc_rows
                    if r.algo == algo and (r.mode or "") == mode
                    and r.payload_bytes == payload and r.cluster_size == size
                ]
                cells.append(f"{match[0].p99_ms:.1f}" if match else "—")
            body.append(cells)
        return Table(
            caption="Per-call 지연 p99 (ms) — Algorithm × Mode × Payload × Cluster size",
            headers=headers,
            rows=body,
        )

    def errors_per_call(self, rows: Iterable[ReportRow]) -> Table:
        """HOS-Step13 §3.3: error counts per cell in the same grid format."""
        pc_rows = [r for r in rows if r.family in (Family.PER_CALL, Family.PER_CALL_RAW)]
        keys = sorted({(r.algo, r.mode or "", r.payload_bytes) for r in pc_rows})
        headers = ["Algorithm", "Mode", "Payload"] + [f"cs={s}" for s in CLUSTER_SIZES]
        body: list[list[str]] = []
        for algo, mode, payload in keys:
            cells = [algo, mode, str(payload)]
            for size in CLUSTER_SIZES:
                match = [
                    r for r in pc_rows
                    if r.algo == algo and (r.mode or "") == mode
                    and r.payload_bytes == payload and r.cluster_size == size
                ]
                cells.append(str(match[0].error_count) if match else "—")
            body.append(cells)
        return Table(
            caption="오류 건수 — Algorithm × Mode × Payload × Cluster size",
            headers=headers,
            rows=body,
        )

    def core_results(
        self,
        aggregates: list,
        desired_size: int,
    ) -> Table:
        """§1 핵심 결과 — cluster-size별 평균 / cs=desired 대비 비율 / 이론값 / peak."""
        if not aggregates:
            return Table(
                caption="핵심 결과 (측정 데이터 없음)",
                headers=["HSM 갯수", "평균 처리량 (ops/s)", "cs=desired 대비", "이론 (N/desired)", "최고 셀"],
                rows=[],
            )
        baseline = next((a for a in aggregates if a.cluster_size == desired_size), None)
        baseline_ops = baseline.mean_ops_per_sec if baseline else (
            max(a.mean_ops_per_sec for a in aggregates)
        )
        body: list[list[str]] = []
        for a in aggregates:
            ratio_pct = (a.mean_ops_per_sec / baseline_ops * 100.0) if baseline_ops else 0.0
            ideal_pct = (a.cluster_size / desired_size * 100.0) if desired_size else 0.0
            body.append([
                str(a.cluster_size),
                f"{a.mean_ops_per_sec:,.0f}",
                f"{ratio_pct:.0f}%",
                f"{ideal_pct:.0f}%",
                f"{a.peak_ops_per_sec:,.0f} ({a.peak_label})",
            ])
        return Table(
            caption="핵심 결과 — Cluster size 별 평균 처리량과 선형성",
            headers=["HSM 갯수", "평균 처리량 (ops/s)", f"cs={desired_size} 대비", f"이론 (N/{desired_size})", "최고 셀"],
            rows=body,
        )

    def scalability(self, points: list[LinearityPoint]) -> Table:
        """Linearity table. The 'Required HSMs = ceil(Target ÷ per-HSM)' formula
        is documented in §7 prose, not embedded in the data table."""
        ordered = sorted(points, key=lambda p: p.cluster_size)
        body: list[list[str]] = []
        for p in ordered:
            body.append([
                str(p.cluster_size),
                f"{p.measured_ops_per_sec:,.0f}",
                f"{p.ideal_linear_ops_per_sec:,.0f}",
                f"{p.per_hsm_ops:,.0f}",
                f"{p.linearity_ratio * 100:.1f}%",
            ])
        return Table(
            caption="확장성 분석 — Cluster size별 측정/이상선형 처리량 및 선형성",
            headers=[
                "Cluster size",
                "측정 (ops/s)",
                "이상선형 (ops/s)",
                "Per-HSM (ops/s)",
                "Linearity (%)",
            ],
            rows=body,
        )
