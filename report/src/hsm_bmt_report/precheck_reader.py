"""PrecheckReader — loads cryptogram / iperf3 / ENA baseline JSON files."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import boto3

from .models import CryptogramEvidence, EnaBaseline, EnaSnapshot, IperfBaseline


class PrecheckReader:
    def __init__(self, bucket: str, run_id: str, s3_client: Any | None = None) -> None:
        self.bucket = bucket
        self.run_id = run_id
        self._s3 = s3_client or boto3.client("s3")

    def cryptogram(self) -> CryptogramEvidence | None:
        data = self._load(f"precheck/{self.run_id}/cryptogram.json")
        if data is None:
            return None
        return CryptogramEvidence(
            run_id=data["run_id"],
            captured_at=datetime.fromisoformat(data["captured_at"]),
            cmac_hex=data["cmac_hex"],
            matches_expected=data.get("matches_expected", False),
            expected_cmac_hex=data.get("expected_cmac_hex"),
        )

    def iperf3(self) -> IperfBaseline | None:
        data = self._load(f"precheck/{self.run_id}/iperf3.json")
        if data is None:
            return None
        return IperfBaseline(
            captured_at=datetime.fromisoformat(data["captured_at"]),
            sustained_gbps=data["sustained_gbps"],
            target_gbps=data.get("target_gbps", 15.0),
            pass_threshold_pct=data.get("pass_threshold_pct", 95.0),
        )

    def ena_baseline(self) -> EnaBaseline | None:
        data = self._load(f"precheck/{self.run_id}/ena-baseline.json")
        if data is None:
            return None
        snap = data["snapshot"]
        return EnaBaseline(
            captured_at=datetime.fromisoformat(data["captured_at"]),
            snapshot=EnaSnapshot(
                captured_at=datetime.fromisoformat(snap["captured_at"]),
                bw_in_allowance_exceeded=snap["bw_in_allowance_exceeded"],
                bw_out_allowance_exceeded=snap["bw_out_allowance_exceeded"],
                pps_allowance_exceeded=snap["pps_allowance_exceeded"],
                conntrack_allowance_exceeded=snap["conntrack_allowance_exceeded"],
                link_local_allowance_exceeded=snap["link_local_allowance_exceeded"],
            ),
        )

    def _load(self, key: str) -> dict[str, Any] | None:
        """Load a JSON precheck artifact.

        Returns ``None`` only when the object truly is absent (S3 NoSuchKey).
        For any other failure mode — JSON parse error, schema mismatch
        (KeyError on a required field), unexpected S3 error — we re-raise so
        the caller can decide; previously a broad ``except: return None``
        silently turned malformed artifacts into "MISSING", which made it
        impossible for the customer to tell "we forgot to upload" from
        "we uploaded a corrupt file".
        """
        try:
            obj = self._s3.get_object(Bucket=self.bucket, Key=key)
        except self._s3.exceptions.NoSuchKey:  # type: ignore[attr-defined]
            return None
        return json.loads(obj["Body"].read().decode("utf-8"))
