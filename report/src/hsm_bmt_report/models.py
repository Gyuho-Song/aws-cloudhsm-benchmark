"""Data models that mirror the loader's `MeasurementResult` and add report-side
projections (`ReportRow`, `LinearityPoint`, evidence records).

All models use frozen dataclasses for safe sharing across the report pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class Family(str, Enum):
    V3 = "V3"
    PER_CALL = "PER_CALL"
    # U-CH-5: KEK-reuse PER_CALL family (C native bench + Java KekReuse path).
    # The aggregator/tables layer treats it as a sibling of PER_CALL for
    # report row generation — both fold into the per-call section.
    PER_CALL_RAW = "PER_CALL_RAW"


class Variant(str, Enum):
    # Variant tag is preserved on MeasurementResult to faithfully mirror the
    # parquet column written by the C bench / Java loader. The report itself
    # does not render Variant comparisons (production scenarios run Variant A
    # only — the historical Variant A vs B section was retired 2026-05-22).
    A = "A"
    B = "B"
    NA = "NA"


@dataclass(frozen=True)
class LatencyStats:
    count: int
    p50_ns: int
    p95_ns: int
    p99_ns: int
    max_ns: int


@dataclass(frozen=True)
class EnaSnapshot:
    captured_at: datetime
    bw_in_allowance_exceeded: int
    bw_out_allowance_exceeded: int
    pps_allowance_exceeded: int
    conntrack_allowance_exceeded: int
    link_local_allowance_exceeded: int


@dataclass(frozen=True)
class MeasurementResult:
    """Mirror of the loader's per-cell measurement result row."""

    run_id: str
    unit_id: str
    family: Family
    algo: str
    mode: str
    payload_bytes: int
    cluster_size: int
    variant: Variant
    ops_count: int
    ops_per_sec: float
    p50_ns: int
    p95_ns: int
    p99_ns: int
    error_count: int
    ena_pre: EnaSnapshot
    ena_post: EnaSnapshot
    tcp_retransmit_delta: int
    start_ts: datetime
    end_ts: datetime
    binary_sha256: str
    binary_s3_version_id: str
    valid: bool
    invalid_reason: str | None = None
    per_call_stats: dict[str, LatencyStats] = field(default_factory=dict)
    # U-CH-7 / FR-CH-8.3.4: per-process drilldown.
    # `process_idx` is the Hive partition value promoted onto the row by
    # S3DataReader (default "0" for legacy single-proc parquet without a
    # proc=* partition).
    # `sub_process_count` and `sub_process_rows` are populated by
    # `s3_reader.reduce_multiproc()` ONLY on the reduced cell row. The
    # individual per-proc rows it groups have count=1 / rows=() and are
    # carried in the parent's `sub_process_rows` tuple.
    process_idx: str = "0"
    sub_process_count: int = 1
    sub_process_rows: tuple["MeasurementResult", ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ReportRow:
    family: Family
    algo: str
    mode: str | None
    payload_bytes: int
    cluster_size: int
    ops_per_sec: float
    p50_ms: float
    p95_ms: float
    p99_ms: float
    error_count: int
    valid: bool


@dataclass(frozen=True)
class LinearityPoint:
    """Per-cluster-size throughput vs. ideal linear scaling.

    ``ideal_linear_ops_per_sec`` is the throughput that would be achieved if scaling
    were perfectly linear from the smallest cluster size:
    ``baseline_per_hsm × cluster_size``.
    """

    cluster_size: int
    measured_ops_per_sec: float
    ideal_linear_ops_per_sec: float

    @property
    def per_hsm_ops(self) -> float:
        return self.measured_ops_per_sec / self.cluster_size if self.cluster_size else 0.0

    @property
    def linearity_ratio(self) -> float:
        if self.ideal_linear_ops_per_sec == 0:
            return 0.0
        return self.measured_ops_per_sec / self.ideal_linear_ops_per_sec


@dataclass(frozen=True)
class CryptogramEvidence:
    """Pre-check Gate 2 / AC-8 evidence."""

    run_id: str
    captured_at: datetime
    cmac_hex: str
    matches_expected: bool
    expected_cmac_hex: str | None


@dataclass(frozen=True)
class IperfBaseline:
    """Pre-check Gate 1 / NFR-2.3 evidence."""

    captured_at: datetime
    sustained_gbps: float
    target_gbps: float
    pass_threshold_pct: float = 95.0

    @property
    def passed(self) -> bool:
        return (self.sustained_gbps / self.target_gbps * 100.0) >= self.pass_threshold_pct


@dataclass(frozen=True)
class EnaBaseline:
    """Baseline ENA counters before measurement begins (Pre-check Gate 1)."""

    captured_at: datetime
    snapshot: EnaSnapshot

    @property
    def all_zero(self) -> bool:
        s = self.snapshot
        return (
            s.bw_in_allowance_exceeded == 0
            and s.bw_out_allowance_exceeded == 0
            and s.pps_allowance_exceeded == 0
            and s.conntrack_allowance_exceeded == 0
            and s.link_local_allowance_exceeded == 0
        )


@dataclass(frozen=True)
class Table:
    """Renderable table used by HtmlRenderer / PdfRenderer."""

    caption: str
    headers: list[str]
    rows: list[list[str]]


@dataclass(frozen=True)
class ChartArtifact:
    png_bytes: bytes
    svg_str: str
    alt_text_ko: str


@dataclass(frozen=True)
class AppendixSection:
    title_ko: str
    body_html: str


@dataclass(frozen=True)
class CompletenessReport:
    """How many of the expected measurement units arrived & passed.

    ``expected_units`` is supplied by the caller (typically from the DDB run
    row's ``totalUnits`` field, which web-api ``start-run.ts`` computes from
    the user's ``matrixSubset``). Surfaced in §0 요약 to make a partial run
    obvious.
    """

    expected_units: int
    valid_units: int
    invalid_units: int
    missing_unit_ids: list[str]

    @property
    def completion_pct(self) -> float:
        if self.expected_units == 0:
            return 0.0
        return self.valid_units / self.expected_units * 100.0


@dataclass(frozen=True)
class RuntimeContext:
    """Identifies which loader / bench produced this run.

    ``runner`` mirrors the value web-api ``start-run.ts`` writes to the DDB
    matrixSubset (``c-native-multiproc`` | ``java-multiproc`` | ``java-jvm``).
    Templates use ``kind`` to switch §1/§2 prose between the C-native and
    Java code paths so that hardcoded JVM/Virtual-Threads claims do not ship
    when the run was c-native (and vice versa).
    """

    runner: str  # raw matrixSubset.runner value
    kind: str    # 'c-native' or 'java'

    @property
    def is_c_native(self) -> bool:
        return self.kind == "c-native"


@dataclass(frozen=True)
class MethodContext:
    """Method-section facts derived from the actual scenario / runner.

    Populated by ``__main__`` so §2 prose does not hardcode
    "13 calls / 200 Virtual Threads / 30 s cooldown" when the production
    c-native path measures 8 steps with pthread workers and uses 30 s
    cell-cooldown + 300 s cluster-cooldown.
    """

    v3_steps_per_tx: int
    v3_steps_note_ko: str
    per_call_modes_ko: str
    warmup_s: int
    steady_s: int
    cell_cooldown_s: int
    cluster_cooldown_s: int
    worker_description_ko: str


@dataclass(frozen=True)
class ClusterAggregate:
    """Per-cluster-size aggregate of throughput cells (HOS Step 13)."""

    cluster_size: int
    cell_count: int
    mean_ops_per_sec: float
    peak_ops_per_sec: float
    peak_label: str  # e.g. "AES-256 CMAC 256B"


@dataclass(frozen=True)
class CoreResults:
    """§1 핵심 결과 — cluster size 별 평균 + cs=6 대비 비율 + 이론 N/desired 비율."""

    aggregates: list[ClusterAggregate]
    desired_size: int  # baseline (typically 6)
    total_cells: int
    total_errors: int
    total_transactions: int
    measurement_seconds_per_cell: int


@dataclass(frozen=True)
class OperationalGuidance:
    """§5 운영 가이드 — BizTPS 환산 + HSM 갯수별 권장 + 동시성 권장."""

    biztps_examples: list[tuple[str, str]]  # [(label, value)]
    hsm_recommendations: list[tuple[str, str, str]]  # [(scenario, hsms, basis)]
    concurrency_recommendations: list[tuple[int, int]]  # [(cluster_size, max_concurrent)]


@dataclass(frozen=True)
class ReportContext:
    """HOS-Step13 v2 schema. Slimmed-down: 5 sections (cover/§1/§2/§3/§4/§5).

    Retired fields (V3 tables, scalability, network evidence, 5 appendices,
    summary_headline, completeness %, multiproc caveat) — see
    hard-only-scenarios-plan §10A.
    """

    run_id: str
    generated_at: datetime
    runtime: RuntimeContext | None
    method: MethodContext | None
    # §1 핵심 결과
    core_results: CoreResults
    # §4 측정 결과 상세 — cell-level grids
    per_call_throughput_table: Table
    per_call_latency_table: Table
    per_call_error_table: Table
    # §5 운영 가이드
    operational_guidance: OperationalGuidance
    # Environment (§2) — pulled from DDB run_meta + measured binary
    binary_sha256: str
    binary_version_id: str
    started_at: datetime | None
    completed_at: datetime | None
    cluster_size_sweep: list[int]  # e.g. [6,5,4,3,2] for Full, [3] for Partial
