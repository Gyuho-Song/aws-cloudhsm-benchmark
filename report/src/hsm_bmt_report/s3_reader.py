"""S3DataReader — loads Parquet measurement files for a run.

Loader (Unit 2) writes Parquet output to:

    Single-JVM (legacy):
        s3://<bucket>/runs/<run_id>/family=<F>/unit=<unit_id>/result.parquet

    Multi-proc (U-CH-4 Java + U-CH-5 C bench):
        s3://<bucket>/runs/<run_id>/family=<F>/unit=<unit_id>/proc=<idx>/result.parquet

This is Hive-style partitioning, so we use ``pyarrow.dataset`` with
``partitioning='hive'`` rather than listing every key and reading them one by one.
The dataset API also lets us push a family filter down to the scan.

When the dataset includes ``proc=*`` partitions, ``S3DataReader`` reduces them
per-unit before returning a flat list of MeasurementResult: ops_per_sec is
summed (per-proc throughputs combine to the cell-aggregate), p99/p95 are taken
as the per-proc max (worst-case observed), p50 as the count-weighted mean,
ops_count is summed, error_count is summed. ENA snapshots / per_call_stats are
taken from proc=0 (representative) since they're cell-level not per-proc.

Parquet schema (mirrors Java Loader's ``ParquetResultWriter``):

  run_id                : string
  unit_id               : string
  family                : string (partition)        # "V3" | "PER_CALL"
  algo                  : string                    # "AES_128" | "AES_256"
  mode                  : string                    # "ECB" | "CBC" | "CTR" | "GCM" | "CMAC"
  payload_bytes         : int32
  cluster_size          : int32
  variant               : string                    # "A" | "B" | "NA"
  ops_count             : int64
  ops_per_sec           : float64
  p50_ns / p95_ns / p99_ns        : int64
  error_count           : int64
  tcp_retransmit_delta  : int64
  start_ts / end_ts                : timestamp[ns,UTC]
  binary_sha256         : string
  binary_s3_version_id  : string
  valid                 : bool
  invalid_reason        : string (nullable)
  per_call_stats        : map<string, struct<count:i64, p50_ns:i64, p95_ns:i64, p99_ns:i64, max_ns:i64>>
  error_counts          : map<string, int64>
  ena_pre_*  / ena_post_*           : flat columns (see _row_to_result)

Loader-side ``ParquetResultWriter`` MUST emit this schema; tests use a synthetic
fixture generator that mirrors it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import boto3

from .models import EnaSnapshot, Family, LatencyStats, MeasurementResult, Variant


class S3DataReader:
    def __init__(self, bucket: str, run_id: str, s3_client: Any | None = None) -> None:
        self.bucket = bucket
        self.run_id = run_id
        self._s3 = s3_client or boto3.client("s3")

    def load_all(self) -> list[MeasurementResult]:
        return self._scan(family=None)

    def load_family(self, family: Family) -> list[MeasurementResult]:
        return self._scan(family=family)

    def list_keys(self, family: Family | None = None) -> list[str]:
        """Object-listing fallback — used by tests + when pyarrow.dataset isn't desired."""
        prefix = f"runs/{self.run_id}/"
        if family is not None:
            prefix = f"{prefix}family={family.value}/"
        keys: list[str] = []
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                if key.endswith(".parquet"):
                    keys.append(key)
        return keys

    def _scan(self, family: Family | None) -> list[MeasurementResult]:
        # Lazy-import pyarrow so unit tests can stub without the dep installed.
        import pyarrow as pa
        import pyarrow.dataset as ds
        import pyarrow.fs as pafs

        s3_fs = pafs.S3FileSystem(region="ap-northeast-2")
        path = f"{self.bucket}/runs/{self.run_id}/"
        dataset = ds.dataset(path, filesystem=s3_fs, format="parquet", partitioning="hive")
        scan_filter = (ds.field("family") == family.value) if family is not None else None
        table = dataset.to_table(filter=scan_filter)
        # Loader's ParquetResultWriter emits timestamps at nanosecond resolution.
        # pyarrow's Table.to_pylist() refuses to convert ns→datetime without pandas;
        # downcast every ns timestamp column to microseconds so to_pylist() yields
        # plain datetime.datetime values. Sub-microsecond precision in start/end_ts
        # is not used by the report; truncate (safe=False) instead of failing.
        import pyarrow.compute as pc
        for i, field in enumerate(table.schema):
            t = field.type
            if pa.types.is_timestamp(t) and t.unit == "ns":
                target = pa.timestamp("us", tz=t.tz)
                table = table.set_column(i, field.with_type(target),
                                         pc.cast(table.column(i), target, safe=False))
        rows = [_row_to_result(row) for row in table.to_pylist()]
        # U-CH-7: collapse multi-proc per-unit rows into a single row.
        # If the run has no proc=* partitions, group-by unit_id is a no-op
        # (each unit yields exactly one row).
        return reduce_multiproc(rows)


# U-CH-7 / FR-CH-8.3.3: ENA snapshot fields used by the fallback below.
_ENA_FIELDS: tuple[str, ...] = (
    "bw_in_allowance_exceeded",
    "bw_out_allowance_exceeded",
    "pps_allowance_exceeded",
    "conntrack_allowance_exceeded",
    "link_local_allowance_exceeded",
)


def _pick_ena_source(group: list[MeasurementResult]) -> MeasurementResult:
    """Pick the ENA-snapshot source row for a multi-proc cell.

    FR-CH-8.3.3: iterate ascending ``process_idx`` and return the first row
    whose ENA snapshot has ANY non-zero counter (either pre or post). This
    keeps the report from showing all-zero ENA when proc=0's snapshot was
    lost while a sibling proc captured real allowance-exceeded numbers.

    Falls back to the lowest ``process_idx`` if every proc has all-zero ENA.
    """
    ordered = sorted(group, key=lambda r: r.process_idx)
    for r in ordered:
        if any(getattr(r.ena_pre, f) for f in _ENA_FIELDS) \
                or any(getattr(r.ena_post, f) for f in _ENA_FIELDS):
            return r
    return ordered[0]


def reduce_multiproc(rows: list[MeasurementResult]) -> list[MeasurementResult]:
    """Reduce per-proc rows down to one row per unit_id.

    Aggregation rules (U-CH-7):
      - ops_per_sec, ops_count, error_count, tcp_retransmit_delta : SUM
      - p99_ns, p95_ns                                            : MAX (worst observed)
      - p50_ns                                                    : ops-weighted mean
      - ena_pre / ena_post                                         : `_pick_ena_source`
        — first row in ascending ``process_idx`` with any non-zero ENA counter
        (FR-CH-8.3.3 robustness against proc=0 snapshot loss)
      - per_call_stats / metadata (run_id, family, algo, mode, payload, ...) :
        taken from the lowest ``process_idx`` row

    The reduced row preserves all per-proc rows in ``sub_process_rows``
    (sorted ascending by ``process_idx``) and sets ``sub_process_count`` so
    `appendix.render_subprocess_section` can render a per-cell drilldown.

    A run produced by the legacy single-row writer (no proc=* partitions)
    yields exactly one row per unit_id; the reduction is a no-op (the row
    keeps its default ``sub_process_count=1`` / empty ``sub_process_rows``).
    """
    if not rows:
        return rows
    by_unit: dict[str, list[MeasurementResult]] = {}
    for r in rows:
        by_unit.setdefault(r.unit_id, []).append(r)
    out: list[MeasurementResult] = []
    for unit_id, group in by_unit.items():
        if len(group) == 1:
            out.append(group[0])
            continue
        ordered = sorted(group, key=lambda r: r.process_idx)
        # Metadata representative: lowest process_idx (deterministic +
        # matches FR-CH-8.3.3's "ascending process_idx" picking convention).
        meta = ordered[0]
        ena_src = _pick_ena_source(group)
        sum_ops_count = sum(x.ops_count for x in group)
        sum_ops_per_sec = sum(x.ops_per_sec for x in group)
        sum_errs = sum(x.error_count for x in group)
        sum_tcp_rtx = sum(x.tcp_retransmit_delta for x in group)
        max_p95 = max(x.p95_ns for x in group)
        max_p99 = max(x.p99_ns for x in group)
        # Weighted-mean p50 by ops_count. Falls back to per-proc mean if every
        # proc has zero count (degenerate; the cell would be marked invalid).
        total = sum_ops_count
        if total > 0:
            p50 = int(sum(x.p50_ns * x.ops_count for x in group) / total)
        else:
            p50 = int(sum(x.p50_ns for x in group) / len(group))
        # valid is AND across procs — if any proc was invalid, the cell is
        # invalid. invalid_reason picks the first non-null.
        valid_all = all(x.valid for x in group)
        invalid_reason = next((x.invalid_reason for x in group if x.invalid_reason), None)
        out.append(
            MeasurementResult(
                run_id=meta.run_id,
                unit_id=unit_id,
                family=meta.family,
                algo=meta.algo,
                mode=meta.mode,
                payload_bytes=meta.payload_bytes,
                cluster_size=meta.cluster_size,
                variant=meta.variant,
                ops_count=sum_ops_count,
                ops_per_sec=sum_ops_per_sec,
                p50_ns=p50,
                p95_ns=max_p95,
                p99_ns=max_p99,
                error_count=sum_errs,
                ena_pre=ena_src.ena_pre,
                ena_post=ena_src.ena_post,
                tcp_retransmit_delta=sum_tcp_rtx,
                start_ts=meta.start_ts,
                end_ts=meta.end_ts,
                binary_sha256=meta.binary_sha256,
                binary_s3_version_id=meta.binary_s3_version_id,
                valid=valid_all,
                invalid_reason=invalid_reason,
                per_call_stats=meta.per_call_stats,
                process_idx=meta.process_idx,
                sub_process_count=len(group),
                sub_process_rows=tuple(ordered),
            )
        )
    return out


def _row_to_result(row: dict[str, Any]) -> MeasurementResult:
    """Maps a flat Parquet row to a MeasurementResult.

    The Hive partition value ``process_idx`` is promoted onto the model so
    `reduce_multiproc` can sort and `appendix.render_subprocess_section` can
    drill down. Legacy parquet without a ``proc=*`` partition (single-proc
    runs predating U-CH-4/U-CH-5) gets the model default ``"0"``.
    """
    ena_pre = EnaSnapshot(
        captured_at=_to_dt(row["ena_pre_captured_at"]),
        bw_in_allowance_exceeded=row["ena_pre_bw_in"],
        bw_out_allowance_exceeded=row["ena_pre_bw_out"],
        pps_allowance_exceeded=row["ena_pre_pps"],
        conntrack_allowance_exceeded=row["ena_pre_conntrack"],
        link_local_allowance_exceeded=row["ena_pre_linklocal"],
    )
    ena_post = EnaSnapshot(
        captured_at=_to_dt(row["ena_post_captured_at"]),
        bw_in_allowance_exceeded=row["ena_post_bw_in"],
        bw_out_allowance_exceeded=row["ena_post_bw_out"],
        pps_allowance_exceeded=row["ena_post_pps"],
        conntrack_allowance_exceeded=row["ena_post_conntrack"],
        link_local_allowance_exceeded=row["ena_post_linklocal"],
    )
    per_call = {
        k: LatencyStats(**v) for k, v in _as_dict(row.get("per_call_stats")).items()
    }
    proc_idx = row.get("process_idx")
    return MeasurementResult(
        run_id=row["run_id"],
        unit_id=row["unit_id"],
        family=Family(row["family"]),
        algo=row["algo"],
        mode=row["mode"],
        payload_bytes=row["payload_bytes"],
        cluster_size=row["cluster_size"],
        variant=Variant(row["variant"]),
        ops_count=row["ops_count"],
        ops_per_sec=row["ops_per_sec"],
        p50_ns=row["p50_ns"],
        p95_ns=row["p95_ns"],
        p99_ns=row["p99_ns"],
        error_count=row["error_count"],
        ena_pre=ena_pre,
        ena_post=ena_post,
        tcp_retransmit_delta=row["tcp_retransmit_delta"],
        start_ts=_to_dt(row["start_ts"]),
        end_ts=_to_dt(row["end_ts"]),
        binary_sha256=row["binary_sha256"],
        binary_s3_version_id=row["binary_s3_version_id"],
        valid=row["valid"],
        invalid_reason=row.get("invalid_reason"),
        per_call_stats=per_call,
        process_idx="0" if proc_idx is None else str(proc_idx),
    )


def _as_dict(v: Any) -> dict[str, Any]:
    """pyarrow's Table.to_pylist() returns parquet map<K,V> columns as a list of
    (k, v) tuples, not a dict. Normalize both forms to a real dict."""
    if v is None:
        return {}
    if isinstance(v, dict):
        return v
    if isinstance(v, list):
        return {k: val for k, val in v}
    raise TypeError(f"unsupported map value: {type(v).__name__}")


def _to_dt(v: Any) -> datetime:
    if isinstance(v, datetime):
        return v
    if isinstance(v, str):
        return datetime.fromisoformat(v)
    raise ValueError(f"unsupported timestamp value: {v!r}")
