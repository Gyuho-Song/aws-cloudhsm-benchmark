"""AppendixBuilder — Korean-language appendix sections for the report."""

from __future__ import annotations

from collections.abc import Iterable

from .models import (
    AppendixSection,
    CryptogramEvidence,
    EnaBaseline,
    Family,
    IperfBaseline,
    MeasurementResult,
)


class AppendixBuilder:
    def conversion_guide(self) -> AppendixSection:
        """Business TPS conversion explanation.

        The hardcoded "÷ 13" example was removed (2026-05-22). The C-native
        bench reports tx/sec where one tx = one V3 sequence as adapted for
        SDK 5 (8 PKCS#11 steps, with C_OpenSession and C_FindObjects(A1)
        cached per worker). Whether the customer's "business transaction"
        equals one V3 sequence or includes additional non-HSM steps is
        operator-specific, so this appendix provides the formula without
        substituting a fabricated divisor.
        """
        body = """
        <p>본 BMT의 결과는 <strong>측정 트랜잭션 단위</strong>의 <strong>ops/sec</strong>
        (= tx/sec) 입니다. 측정 트랜잭션 정의는 측정 방법(§2)에 명시되어 있습니다.</p>

        <p>비즈니스 거래 단위의 TPS로 환산하려면, 운영 환경에서 비즈니스 1건당
        본 측정 트랜잭션이 몇 회 호출되는지를 곱셈/나눗셈 계수로 적용합니다.</p>

        <pre>Business TPS = 측정 ops/sec ÷ (비즈니스 1건당 측정-tx 호출 횟수)</pre>

        <p>호출 횟수 계수는 발급/조회/정산 등 거래 유형마다 다르므로 본 보고서는
        고정값을 가정하지 않습니다. 운영팀에서 거래 시나리오별 호출 흐름을
        기준으로 직접 산정하시기 바랍니다.</p>
        """
        return AppendixSection(title_ko="부록 A — ops/sec → 비즈니스 TPS 변환 가이드", body_html=body)

    def v3_throughput_ceiling(self) -> AppendixSection:
        """V3 throughput ceiling vs current production measurement.

        Source: 2026-05-23 procs/threads saturation sweep
        (`aidlc-docs/operations/v3-saturation-sweep-2026-05-23.md`).

        Why this exists in the report — operators reading the V3 throughput
        table see ~1,900 tx/s on the production scenario (procs=2, threads=192)
        and may ask whether more procs would help. The sweep answer:
        peak ≈ 2,030 tx/s @ procs=8 (+6.3% over production), at the cost of
        2.6× p99 latency (5,274 ms vs 2,015 ms). Production keeps procs=2
        as the latency-balanced sweet spot. This appendix records both
        numbers so operators can distinguish "current measurement" from
        "measured ceiling".
        """
        body = """
        <p>본 BMT 의 V3 시퀀스 처리량은 cluster size 6, 동시 worker 384
        (procs=2 × threads=192) 구성으로 측정되었습니다. 이 구성은
        <strong>처리량과 지연을 균형 잡은 운영 sweet spot</strong> 으로 채택된
        값이며, 동일 hardware 의 절대 처리량 한계와는 다릅니다.</p>

        <h4>측정 한계 (saturation sweep, 2026-05-23)</h4>

        <p>같은 cluster (size=6) 에서 procs / threads 를 변경하며 처리량 천장을
        탐색한 결과:</p>

        <table class="data-table">
          <thead>
            <tr>
              <th>구성</th>
              <th>procs</th>
              <th>threads/proc</th>
              <th>tx/sec</th>
              <th>p99 (ms)</th>
              <th>비고</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>현재 운영 측정</td>
              <td>2</td><td>192</td>
              <td>~1,909</td>
              <td>~2,015</td>
              <td>latency-balanced sweet spot</td>
            </tr>
            <tr>
              <td><strong>측정 처리량 ceiling</strong></td>
              <td><strong>8</strong></td><td><strong>192</strong></td>
              <td><strong>~2,030</strong></td>
              <td><strong>~5,274</strong></td>
              <td>peak throughput (+6.3%, p99 2.6× 악화)</td>
            </tr>
            <tr>
              <td>regression 시작점</td>
              <td>12</td><td>192</td>
              <td>~1,972</td>
              <td>~6,176</td>
              <td>cluster mesh contention 발생</td>
            </tr>
          </tbody>
        </table>

        <h4>해석</h4>

        <ul>
          <li><strong>처리량 한계 ≈ 2,030 tx/sec</strong> 가 cluster=6
              hardware 의 V3 시퀀스 ceiling 입니다 (procs=12 부터 throughput
              감소 + p99 폭발로 cluster mesh-replication 한계 도달이 확인됨).</li>
          <li>운영 시나리오는 procs=2 (= 1,909 tx/sec) 를 사용합니다 — peak 대비
              6.3% 손해를 감수하고 p99 를 2,015 ms 로 유지하기 위함입니다.
              Latency 가 운영에 덜 중요하면 procs=4 (1,942 tx/sec, p99 3,788 ms)
              또는 procs=8 (2,030 tx/sec, p99 5,274 ms) 로 운영 가능합니다.</li>
          <li>이 ceiling 은 <strong>매 transaction 마다 새 W1 키를 cluster 6대
              HSM 에 mesh replicate</strong> 하는 V3 spec 의 본질적 비용 때문이며,
              하드웨어 추가(cluster size 증가) 만으로는 선형으로 늘지 않습니다.
              자세한 cluster-size 별 처리량은 §7 확장성 분석을 참조하시기
              바랍니다.</li>
        </ul>

        <h4>측정 방법</h4>

        <p>180초 steady-state, cell 간 30초 cooldown, 동일 axis (AES-128,
        payload 256B, cluster=6, Variant A) 로 procs ∈ {1, 2, 4, 8, 12} 와
        threads ∈ {64, 128, 192, 256, 384} 두 차원에서 sweep. 결과 raw data 는
        본 보고서 산출물과 함께 보관된 <code>v3-saturation-sweep-2026-05-23.md
        </code> 운영 문서를 참조하시기 바랍니다.</p>
        """
        return AppendixSection(title_ko="부록 — V3 시퀀스 처리량 한계", body_html=body)

    def tdes_recommendation(self) -> AppendixSection:
        body = """
        <p><strong>권고: Production 환경에서 TDES(Triple-DES) 사용을 중단하고
        AES-128 또는 AES-256으로 마이그레이션할 것.</strong></p>

        <h4>근거</h4>
        <ul>
          <li>FIPS 140-3 (CMVP)은 2024-01-01부로 TDES 키 신규 생성 및 TDES 암호화
              연산을 금지했습니다 (기존 키의 복호화만 마이그레이션 목적으로 한시적
              허용).</li>
          <li>본 BMT의 CloudHSM 클러스터는 FIPS 모드(140-3 Level 3, Cert #4703)로
              운용되므로 TDES Encrypt 호출이 거부됩니다.</li>
          <li>AES-128 / AES-256은 FIPS 모드에서 완전 지원되며, 본 BMT의 측정
              결과로 충분한 처리량과 지연 특성이 확인되었습니다.</li>
        </ul>

        <h4>실행 단계</h4>
        <ol>
          <li>현재 TDES로 보호 중인 데이터 자산을 식별합니다.</li>
          <li>AES-128 또는 AES-256 키로 재암호화 계획을 수립합니다.</li>
          <li>운영 어플리케이션 코드에서 TDES 호출 경로를 AES 호출로 교체합니다.</li>
          <li>마이그레이션 완료 후 TDES 키는 폐기합니다 (decommission).</li>
        </ol>
        """
        return AppendixSection(title_ko="부록 B — TDES production 제거 권고", body_html=body)

    def precheck_evidence(
        self,
        cryptogram: CryptogramEvidence | None,
        iperf: IperfBaseline | None,
        ena: EnaBaseline | None,
    ) -> AppendixSection:
        parts: list[str] = []
        if cryptogram:
            parts.append(
                f"""
                <h4>단건 V3 cryptogram 검증 (AC-8)</h4>
                <ul>
                  <li>Run ID: {cryptogram.run_id}</li>
                  <li>측정 시각 (UTC): {cryptogram.captured_at.isoformat()}</li>
                  <li>측정 CMAC (hex): <code>{cryptogram.cmac_hex}</code></li>
                  <li>예상 CMAC (hex): <code>{cryptogram.expected_cmac_hex or '(N/A)'}</code></li>
                  <li>일치 여부: <strong>{'PASS ✓' if cryptogram.matches_expected else 'FAIL ✗'}</strong></li>
                </ul>
                """
            )
        else:
            parts.append("<h4>단건 V3 cryptogram 검증 (AC-8)</h4><p>증거 자료 없음 (MISSING).</p>")
        if iperf:
            parts.append(
                f"""
                <h4>iperf3 baseline (NFR-2.3)</h4>
                <ul>
                  <li>측정 시각 (UTC): {iperf.captured_at.isoformat()}</li>
                  <li>지속 처리량: {iperf.sustained_gbps:.2f} Gbps
                       (목표: {iperf.target_gbps:.0f} Gbps의
                       {iperf.pass_threshold_pct:.0f}% 이상)</li>
                  <li>판정: <strong>{'PASS ✓' if iperf.passed else 'FAIL ✗'}</strong></li>
                </ul>
                """
            )
        else:
            parts.append("<h4>iperf3 baseline (NFR-2.3)</h4><p>증거 자료 없음 (MISSING).</p>")
        if ena:
            parts.append(
                f"""
                <h4>ENA baseline 스냅샷 (NFR-2.4)</h4>
                <ul>
                  <li>측정 시각 (UTC): {ena.captured_at.isoformat()}</li>
                  <li>모든 *_allowance_exceeded 카운터 = 0:
                       <strong>{'YES ✓' if ena.all_zero else 'NO ✗'}</strong></li>
                </ul>
                <p class="footnote">본 스냅샷은 측정 시작 직전의 단일 시점 값입니다.
                측정 기간 동안의 ENA 카운터 변화는 §9 표의 각 측정 단위 pre/post
                차이를 통해 별도로 보고합니다.</p>
                """
            )
        else:
            parts.append("<h4>ENA baseline 스냅샷 (NFR-2.4)</h4><p>증거 자료 없음 (MISSING).</p>")
        body = "\n".join(parts)
        return AppendixSection(title_ko="부록 C — Pre-check 증거", body_html=body)

    def subprocess_drilldown(self, results: Iterable[MeasurementResult]) -> AppendixSection:
        """U-CH-7 / FR-CH-8.3.4: per-cell breakdown of multi-proc results.

        For every cell with N>1 sub-processes, render a sub-table whose rows
        list ``process_idx`` ascending with the per-proc throughput +
        latency (ms) + error count. Cells with N=1 are omitted.
        """
        cells = [r for r in results if r.sub_process_count > 1]
        if not cells:
            return AppendixSection(
                title_ko="부록 D — 프로세스별 결과",
                body_html="<p>multi-proc 셀이 없습니다 (procs=1).</p>",
            )
        cells = sorted(
            cells,
            key=lambda r: (r.family.value, r.algo, r.mode or "",
                           r.payload_bytes, r.cluster_size),
        )
        parts: list[str] = []
        for cell in cells:
            family_label = cell.family.value
            mode_label = f" {cell.mode}" if cell.family != Family.V3 else ""
            heading = (
                f"<h4>{family_label} · {cell.algo}{mode_label} · "
                f"payload {cell.payload_bytes}B · cluster {cell.cluster_size} · "
                f"{cell.sub_process_count} procs</h4>"
            )
            rows_html = "".join(
                f"<tr><td>{p.process_idx}</td>"
                f"<td>{p.ops_per_sec:,.0f}</td>"
                f"<td>{p.p50_ns / 1_000_000:.2f}</td>"
                f"<td>{p.p95_ns / 1_000_000:.2f}</td>"
                f"<td>{p.p99_ns / 1_000_000:.2f}</td>"
                f"<td>{p.error_count}</td></tr>"
                for p in cell.sub_process_rows
            )
            parts.append(
                heading
                + "<table><thead><tr>"
                + "<th>process_idx</th><th>ops/sec</th>"
                + "<th>p50 (ms)</th><th>p95 (ms)</th><th>p99 (ms)</th>"
                + "<th>errors</th></tr></thead>"
                + f"<tbody>{rows_html}</tbody></table>"
            )
        return AppendixSection(
            title_ko="부록 D — 프로세스별 결과",
            body_html="\n".join(parts),
        )
