"""ChartRenderer — Matplotlib figures emitted as PNG (for PDF) and inline SVG (for HTML)."""

from __future__ import annotations

import io
import logging
from collections.abc import Iterable

import matplotlib

matplotlib.use("Agg")  # headless

import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402

from .models import ChartArtifact, Family, LinearityPoint, MeasurementResult

_log = logging.getLogger(__name__)


def _configure_korean_font() -> None:
    """Configure Matplotlib to render CJK glyphs (avoid tofu boxes)."""
    candidates = [
        "Noto Sans CJK KR",
        "NotoSansCJKkr",
        "Noto Sans KR",
        "NanumGothic",
        "Malgun Gothic",
    ]
    available = {f.name for f in font_manager.fontManager.ttflist}
    chosen = next((c for c in candidates if c in available), None)
    if chosen:
        plt.rcParams["font.family"] = chosen
    else:
        _log.warning(
            "No Korean CJK font found in Matplotlib font manager. "
            "CJK glyphs in charts will render as tofu boxes. Install Noto Sans CJK KR "
            "(e.g. `dnf install google-noto-sans-cjk-ttc-fonts`)."
        )
    plt.rcParams["axes.unicode_minus"] = False


_configure_korean_font()


class ChartRenderer:
    DPI = 144
    FIG_SIZE = (8.0, 4.5)

    def linearity(self, points: Iterable[LinearityPoint]) -> ChartArtifact:
        ordered = sorted(points, key=lambda p: p.cluster_size)
        sizes = [p.cluster_size for p in ordered]
        measured = [p.measured_ops_per_sec for p in ordered]
        ideal = [p.ideal_linear_ops_per_sec for p in ordered]

        fig, ax = plt.subplots(figsize=self.FIG_SIZE, dpi=self.DPI)
        ax.plot(sizes, measured, marker="o", label="실측 처리량")
        if ideal:
            ax.plot(sizes, ideal, linestyle="--", label="이상적 선형 (baseline×size)")
        ax.set_xlabel("Cluster size (HSM 수)")
        ax.set_ylabel("Throughput (ops/sec)")
        ax.set_title("확장성: Cluster size별 처리량 vs. 이상적 선형")
        ax.legend()
        ax.grid(True, alpha=0.3)
        return self._emit(fig, "Cluster size별 측정 처리량과 이상적 선형 추세선")

    def v3_mean_p99_by_cluster(self, results: Iterable[MeasurementResult]) -> ChartArtifact:
        """V3-only: cluster-size 별 평균 p99 (ms) line chart.

        Filters to ``Family.V3`` so the V3 latency section's chart is not
        contaminated with PER_CALL p99 values when both families coexist
        in the same run.
        """
        v3 = [r for r in results if r.family == Family.V3]
        if not v3:
            return self._empty("V3 지연 분포 데이터 없음")
        by_size: dict[int, list[float]] = {}
        for r in v3:
            by_size.setdefault(r.cluster_size, []).append(r.p99_ns / 1_000_000.0)
        sizes = sorted(by_size.keys())
        means = [sum(by_size[s]) / len(by_size[s]) for s in sizes]
        fig, ax = plt.subplots(figsize=self.FIG_SIZE, dpi=self.DPI)
        ax.plot(sizes, means, marker="s")
        ax.set_xlabel("Cluster size (HSM 수)")
        ax.set_ylabel("Mean p99 latency (ms)")
        ax.set_title("V3: Cluster size별 평균 p99 지연")
        ax.grid(True, alpha=0.3)
        return self._emit(fig, "V3 시퀀스의 Cluster size별 평균 p99 지연 시간(ms)")

    def _emit(self, fig: "plt.Figure", alt_text: str) -> ChartArtifact:
        png_buf = io.BytesIO()
        fig.savefig(png_buf, format="png", bbox_inches="tight")
        svg_buf = io.StringIO()
        fig.savefig(svg_buf, format="svg", bbox_inches="tight")
        plt.close(fig)
        return ChartArtifact(
            png_bytes=png_buf.getvalue(),
            svg_str=svg_buf.getvalue(),
            alt_text_ko=alt_text,
        )

    def _empty(self, alt_text: str) -> ChartArtifact:
        fig, ax = plt.subplots(figsize=(4, 2), dpi=self.DPI)
        ax.text(0.5, 0.5, "데이터 없음", ha="center", va="center", fontsize=14)
        ax.axis("off")
        return self._emit(fig, alt_text)
