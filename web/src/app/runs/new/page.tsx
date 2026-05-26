'use client';

import { useEffect, useState } from 'react';
import MatrixSelector, { MatrixSubset } from '@/components/MatrixSelector';
import PreFlightPanel from '@/components/PreFlightPanel';
import { api, ClusterStatus } from '@/lib/apiClient';
import { countUnits } from '@/lib/matrix';
import { SCENARIOS, Scenario, expandScenarioToQueueItems, requiredStartHsmCountFor } from '@/lib/scenarios';
import { enqueue, enqueueMany } from '@/lib/queue';
import { isViewer } from '@/lib/groups';

const CREDS_KEY = 'hsm-bmt-loader-creds';

const accentVar: Record<Scenario['accent'], string> = {
  teal:    'var(--aurora-teal)',
  cyan:    'var(--aurora-cyan)',
  violet:  'var(--aurora-violet)',
  magenta: 'var(--aurora-magenta)',
  amber:   'var(--aurora-amber)',
  lime:    'var(--aurora-lime)',
  // 2026-05-24: rose = us-west-2 multi-cluster scenarios — visually
  // distinct so operators see at a glance the run executes in a different
  // region.
  rose:    'var(--aurora-rose, #f43f5e)',
};

export default function RunControlPage() {
  // U-CH-3: viewer 계정은 Run 실행 / 큐 등록 막음. backend authorizer 가
  // 최종 게이트지만 UI 가 먼저 disable 해서 403 round-trip 회피.
  const [viewerMode, setViewerMode] = useState(false);
  useEffect(() => { setViewerMode(isViewer()); }, []);
  // FR-CH-1.4 exact wording
  const viewerTooltip = '조회 권한입니다. 실행은 admin 으로 로그인하세요.';

  const [matrix, setMatrix] = useState<MatrixSubset | null>(null);
  const [versionId, setVersionId] = useState('');
  const [sha256, setSha256] = useState('');
  // Optional override for loader workerCount (PER_CALL_RAW saturation sweep).
  // Empty string = leave default (64); numeric value = pass through.
  const [workerCount, setWorkerCount] = useState('');
  // 2026-05-26: optional procs override. Empty = use scenario's procs config
  // (custom-hard inherits HSM-adaptive procsByCluster from scenarios.ts).
  // A numeric value here forces every cell to use that procs count regardless
  // of cluster size — useful for saturation sweeps but a footgun for normal
  // measurement (procs=1 cs=3 → 12k ops/s vs sweet-spot ~21k).
  const [procsOverride, setProcsOverride] = useState('');
  const [submitting, setSubmitting] = useState<null | string>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enqueueNotice, setEnqueueNotice] = useState<string | null>(null);
  // Per-scenario partial cluster size override (only used when
  // scenario.partialClusterSizeRequired === true).
  const [partialClusterSize, setPartialClusterSize] =
    useState<Record<string, 2 | 3 | 4 | 5 | 6>>({});
  // Scenario currently being inspected for pre-flight (HOS-Step10). null
  // means no scenario selected yet — PreFlightPanel hides itself.
  const [previewScenario, setPreviewScenario] = useState<Scenario | null>(null);
  // 2026-05-26 (UX hardening): PreFlightPanel raises onReadyChange when the
  // cluster is at the right size for the *previewed* scenario AND idle. We
  // also keep our own page-level ClusterStatus so each scenario card can
  // independently disable its own start buttons (and show a per-card
  // tooltip) without requiring the operator to click the card first to
  // reveal a problem.
  // Without the page-level gate, clicks during scaling reach the backend,
  // which 409/422-rejects, and the UI was surfacing the raw JSON body —
  // confusing operators. With the gate they can't even attempt it.
  const [, setPreFlightReady] = useState(false);
  const [clusterStatus, setClusterStatus] = useState<ClusterStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await api.getClusterStatus();
        if (!cancelled) setClusterStatus(s);
      } catch {
        if (!cancelled) setClusterStatus(null);
      }
    };
    refresh();
    // 10s while scaling, 30s when idle/degraded — match HsmStatusBadge.
    const id = window.setInterval(refresh, clusterStatus?.uiState === 'scaling' ? 10_000 : 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [clusterStatus?.uiState]);

  /** Why a given scenario cannot be started right now (or null if it can). */
  const scenarioBlockReason = (s: Scenario): string | null => {
    if (!clusterStatus) return '클러스터 상태 확인 중…';
    if (clusterStatus.uiState === 'scaling') {
      const target = clusterStatus.scalingTarget ?? clusterStatus.desiredCount;
      return `클러스터 스케일링 중 (${clusterStatus.activeCount} → ${target}) — 완료 후 시작 가능`;
    }
    if (clusterStatus.uiState === 'unknown' || clusterStatus.uiState === 'stale') {
      return '클러스터 상태가 불안정합니다. 헤더의 안내를 먼저 처리하세요.';
    }
    // idle or degraded — check size requirement.
    // For Custom-HARD we use the live MatrixSelector pick (state `matrix`)
    // because s.matrix is just a procs-bearing template. For Partial we
    // build a 1-element clusterSizes from the selected pill. For other
    // presets, s.matrix is authoritative.
    let scenarioMatrix: MatrixSubset | undefined;
    if (s.partialClusterSizeRequired) {
      const pick = partialClusterSize[s.id];
      scenarioMatrix = pick
        ? { ...s.matrix, clusterSizes: [pick] }
        : s.matrix;
    } else if (s.id === 'custom-hard') {
      scenarioMatrix = matrix ?? undefined;
    } else {
      scenarioMatrix = s.matrix;
    }
    const required = requiredStartHsmCountFor(s, scenarioMatrix);
    if (clusterStatus.activeCount < required) {
      return `cs=${required} 필요 (현재 cs=${clusterStatus.activeCount}). 먼저 프로비저닝하세요.`;
    }
    return null;
  };

  // SSM is the source of truth for the latest published loader. Always fetch
  // fresh so a new build immediately propagates without operators clearing
  // localStorage. localStorage is only used as a fast-path cache that an
  // immediate API success will overwrite.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CREDS_KEY);
      if (raw) {
        const c = JSON.parse(raw) as { v?: string; s?: string };
        if (c.v) setVersionId(c.v);
        if (c.s) setSha256(c.s);
      }
    } catch { /* ignore */ }
    api.loaderInfo()
      .then((info) => {
        if (info.versionId) setVersionId(info.versionId);
        if (info.sha256) setSha256(info.sha256);
      })
      .catch(() => { /* not fatal */ });
  }, []);
  useEffect(() => {
    if (versionId || sha256) {
      window.localStorage.setItem(CREDS_KEY, JSON.stringify({ v: versionId, s: sha256 }));
    }
  }, [versionId, sha256]);

  const credsReady = !!versionId && !!sha256;
  const disabledTitle = viewerMode
    ? viewerTooltip
    : (credsReady ? undefined : 'Loader binary 검증 정보(versionId, sha256)를 먼저 입력하세요 — NFR-3.5');
  const canExecute = !viewerMode && credsReady;

  const start = async (m: MatrixSubset, label: string, scenario?: Scenario) => {
    if (!credsReady) {
      setError('우측 패널의 Loader binary 검증 정보를 먼저 입력하세요 (NFR-3.5).');
      return;
    }
    // 2026-05-26: defense-in-depth. Every entry path into start() must satisfy
    // a non-empty matrix. UI button-disabled state SHOULD prevent reaching
    // here with empty axes, but a stale React state, a race during state
    // transition, or any future caller could slip past — so re-check here
    // before any setSubmitting/api.startRun call. Note: partial scenarios
    // are about to fix clusterSizes below; check the OTHER axes only here,
    // then re-check the final effective matrix after the partial fix.
    if (!m || m.algorithms.length === 0 || m.modes.length === 0
        || m.payloadBytes.length === 0
        || (!scenario?.partialClusterSizeRequired && m.clusterSizes.length === 0)) {
      setError('algo / mode / payload / cluster size 를 모두 1개 이상 선택하세요.');
      return;
    }
    // Partial scenarios: require a single cluster size pick from the chip group.
    let effective: MatrixSubset = m;
    if (scenario?.partialClusterSizeRequired) {
      const cs = partialClusterSize[scenario.id];
      if (!cs) {
        setError(`${scenario.name}: cluster size를 먼저 선택하세요 (2..6).`);
        return;
      }
      effective = { ...m, clusterSizes: [cs] };
    }
    // Final paranoid check on the effective matrix that will hit backend.
    if (effective.algorithms.length === 0 || effective.modes.length === 0
        || effective.payloadBytes.length === 0 || effective.clusterSizes.length === 0) {
      setError('matrix 가 비어있습니다 — 모든 axis 에서 1개 이상 선택하세요.');
      return;
    }
    setSubmitting(label);
    setError(null);
    try {
      const wc = workerCount.trim() === '' ? undefined : Number(workerCount);
      if (wc !== undefined && (!Number.isInteger(wc) || wc < 16 || wc > 1024)) {
        setError('Worker count override는 16~1024 정수여야 합니다.');
        setSubmitting(null);
        return;
      }
      // procs override: empty → scenario default (HSM-adaptive procsByCluster
      // for custom-hard / per-call-full-hard). Numeric → force this procs for
      // every cell, AND clear procsByCluster so orchestrate.sh's HSM-adaptive
      // lookup doesn't silently overwrite it. We also drop procs256/procs1024
      // for the same reason — operator override wins.
      const po = procsOverride.trim() === '' ? undefined : Number(procsOverride);
      if (po !== undefined && (!Number.isInteger(po) || po < 1 || po > 16)) {
        setError('Procs override는 1~16 정수여야 합니다.');
        setSubmitting(null);
        return;
      }
      if (po !== undefined) {
        const overrideMatrix = { ...effective, procs: po };
        // Strip the per-cluster / per-payload procs maps so the override is
        // actually authoritative. Without this, orchestrate.sh would still
        // run lookup_procs_by_cluster() and overwrite HSM_BMT_PROCS.
        delete (overrideMatrix as { procsByCluster?: unknown }).procsByCluster;
        delete (overrideMatrix as { procs256?: unknown }).procs256;
        delete (overrideMatrix as { procs1024?: unknown }).procs1024;
        effective = overrideMatrix;
      }
      const r = await api.startRun({
        matrixSubset: effective,
        expectedLoaderVersionId: versionId,
        expectedLoaderSha256: sha256,
        ...(wc !== undefined ? { workerCount: wc } : {}),
      });
      setResult(r.runId);
      setTimeout(() => { window.location.href = `/runs/${r.runId}/live`; }, 800);
    } catch (e) {
      setError(String(e));
      setSubmitting(null);
    }
  };

  const queue = (s: Scenario) => {
    if (!credsReady) {
      setError('큐에 넣기 전에도 Loader binary 검증 정보가 필요합니다 (NFR-3.5).');
      return;
    }
    // 2026-05-26: matrix completeness check (preset scenarios are pre-validated
    // but Custom matrix queueing must enforce this).
    const m = s.matrix;
    if (!m || m.algorithms.length === 0 || m.modes.length === 0
        || m.payloadBytes.length === 0 || m.clusterSizes.length === 0) {
      setError('큐에 추가할 수 없습니다 — algo / mode / payload / cluster size 모두 1개 이상 선택하세요.');
      return;
    }
    const fanout = expandScenarioToQueueItems(s);
    enqueueMany(fanout.map((f) => ({
      scenarioId: f.scenarioId,
      scenarioName: f.scenarioName,
      matrix: f.matrix,
      expectedLoaderVersionId: versionId,
      expectedLoaderSha256: sha256,
    })));
    setEnqueueNotice(
      fanout.length > 1
        ? `${s.name} → 큐에 ${fanout.length}개 run으로 추가 (cluster size별 자동 scale)`
        : `${s.name} → 큐에 추가됨`,
    );
    setTimeout(() => setEnqueueNotice(null), 3000);
  };

  const totalUnits = matrix ? countUnits(matrix) : 0;

  return (
    <>
      <section className="page-head rise">
        <div>
          <span className="eyebrow">Compose · benchmark plan</span>
          <h1 className="display">새 <em>Run</em> · 시나리오</h1>
        </div>
        <a className="btn ghost" href="/">← 콘솔</a>
      </section>

      {viewerMode && (
        <div
          role="alert"
          style={{
            marginBottom: '1.5rem',
            padding: '0.85rem 1rem',
            borderRadius: 12,
            border: '1px solid rgba(120,180,255,0.45)',
            background: 'rgba(120,180,255,0.08)',
            color: 'var(--aurora-cyan)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.82rem',
          }}
        >
          조회 전용 계정으로 로그인되어 있습니다. Run 실행 / 큐 등록 버튼은 비활성화됩니다.
          실행 권한이 필요하면 admin 계정으로 다시 로그인해 주세요.
        </div>
      )}

      <div className="layout-split" style={{ marginBottom: '2rem' }}>
        <section className="card rise d1">
          <div>
            <span className="eyebrow">Presets</span>
            <h2 className="title" style={{ marginTop: '0.6rem' }}>표준 시나리오</h2>
            <p className="lede" style={{ marginBottom: 0 }}>
              즉시 실행하거나 큐에 넣어 순차 실행할 수 있습니다. 우측에 loader 검증 정보 먼저 입력.
            </p>
          </div>

          {!credsReady && (
            <div
              style={{
                marginTop: '1rem',
                padding: '0.85rem 1rem',
                borderRadius: 12,
                border: '1px solid rgba(255,184,107,0.45)',
                background: 'rgba(255,184,107,0.08)',
                color: 'var(--aurora-amber)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.82rem',
                display: 'flex', alignItems: 'center', gap: '0.6rem',
              }}
            >
              <span style={{ fontSize: '1.1rem' }}>⚠</span>
              먼저 아래의 <strong style={{ color: 'var(--ink-100)', fontWeight: 600 }}>Loader binary 검증</strong>
              에 versionId / sha256을 입력하세요. 시나리오 / 큐 버튼이 활성화됩니다.
              <a
                href="#loader-creds"
                style={{ marginLeft: 'auto', color: 'var(--aurora-amber)', borderBottom: '1px solid currentColor' }}
              >
                ↓ 입력란으로
              </a>
            </div>
          )}

          <div className="diag" />

          <PreFlightPanel
            scenario={previewScenario}
            matrix={previewScenario && previewScenario.partialClusterSizeRequired
              ? { ...previewScenario.matrix, clusterSizes: partialClusterSize[previewScenario.id]
                  ? [partialClusterSize[previewScenario.id]] : previewScenario.matrix.clusterSizes }
              : previewScenario?.matrix}
            onReadyChange={setPreFlightReady}
          />

          <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            {SCENARIOS.map((s) => {
              const c = accentVar[s.accent];
              const units = countUnits(s.matrix);
              const isPreview = previewScenario?.id === s.id;
              // 2026-05-26: Custom (HARD) preset card uses the operator's
              // MatrixSelector pick (state `matrix`), not the hardcoded
              // s.matrix in scenarios.ts. The other preset cards (Smoke,
              // Full HARD, Partial HARD) use s.matrix directly.
              //
              // 2026-05-26 (procs fix): MatrixSelector emit only carries the
              // 6 selectable axes — it does NOT include procs / procsByCluster
              // / procs256 / procs1024. Without merging the scenario's procs
              // metadata back in, Custom runs land at start-run with
              // procs=undefined → defaults to 1 → cs=3 measured 12,271 ops/s
              // (procs=1 saturation) vs ~21,316 expected at procs=8.
              // Merge the scenario's procs config so Custom-HARD inherits
              // the same HSM-adaptive sweet-spots as Full HARD.
              const isCustomCard = s.id === 'custom-hard';
              const effectiveMatrix: MatrixSubset | null = isCustomCard
                ? (matrix
                    ? {
                        ...matrix,
                        procs: s.matrix.procs ?? matrix.procs,
                        procsByCluster: s.matrix.procsByCluster ?? matrix.procsByCluster,
                        procs256: s.matrix.procs256 ?? matrix.procs256,
                        procs1024: s.matrix.procs1024 ?? matrix.procs1024,
                      }
                    : null)
                : s.matrix;
              const customComplete = isCustomCard
                ? (!!matrix
                    && matrix.algorithms.length > 0
                    && matrix.modes.length > 0
                    && matrix.payloadBytes.length > 0
                    && matrix.clusterSizes.length > 0)
                : true;
              const blockReason = scenarioBlockReason(s);
              const cardDisabled = !canExecute
                || submitting !== null
                || (s.partialClusterSizeRequired && !partialClusterSize[s.id])
                || !customComplete
                || blockReason !== null;
              // Combined tooltip: the most actionable problem first.
              const cardTitle = isCustomCard && !customComplete
                ? '아래의 Custom matrix 에서 algo / mode / payload / cluster size 를 선택하세요'
                : (s.partialClusterSizeRequired && !partialClusterSize[s.id]
                    ? 'Cluster size를 먼저 선택하세요'
                    : (blockReason ?? disabledTitle));
              return (
                <div
                  key={s.id}
                  className="card"
                  style={{
                    padding: '1.2rem 1.3rem',
                    borderColor: isPreview ? c : 'var(--glass-edge)',
                    position: 'relative',
                    cursor: 'pointer',
                  }}
                  onClick={() => setPreviewScenario(s)}
                >
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                      background: `linear-gradient(90deg, transparent, ${c}, transparent)`,
                      filter: 'blur(0.5px)',
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', letterSpacing: '0.16em', textTransform: 'uppercase', color: c }}>
                      {s.id}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--ink-300)' }}>
                      {units} units
                    </span>
                  </div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', marginTop: '0.4rem', color: 'var(--ink-100)', letterSpacing: '-0.01em' }}>
                    {s.name}
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--ink-300)', margin: '0.45rem 0 1rem', lineHeight: 1.5 }}>
                    {s.description}
                  </p>
                  {s.partialClusterSizeRequired && (
                    <div style={{ marginBottom: '0.8rem' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--ink-400)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                        Cluster size (HSM 댓수)
                      </span>
                      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                        {([6, 5, 4, 3, 2] as const).map((n) => {
                          const sel = partialClusterSize[s.id] === n;
                          return (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setPartialClusterSize({ ...partialClusterSize, [s.id]: n })}
                              style={{
                                flex: 1, padding: '0.4rem 0',
                                background: sel ? c : 'transparent',
                                color: sel ? 'var(--bg-0)' : 'var(--ink-200)',
                                border: `1px solid ${sel ? c : 'var(--glass-edge)'}`,
                                borderRadius: 8, cursor: 'pointer',
                                fontFamily: 'var(--font-mono)', fontSize: '0.85rem', fontWeight: 600,
                                transition: 'all 0.15s',
                              }}
                            >
                              {n}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn"
                      style={{ flex: 1, fontSize: '0.85rem' }}
                      disabled={cardDisabled}
                      onClick={() => effectiveMatrix && start(effectiveMatrix, s.id, s)}
                      title={cardTitle}
                    >
                      {submitting === s.id ? '시작 중…' : '바로 실행'}
                    </button>
                    <button
                      className="btn ghost"
                      style={{ flex: 1, fontSize: '0.85rem' }}
                      disabled={cardDisabled}
                      onClick={() => {
                        if (isCustomCard) {
                          // Substitute the operator's matrix into the scenario
                          // record so the queue entry carries the picked axes,
                          // not the placeholder s.matrix. effectiveMatrix
                          // already merges the scenario's procs config so the
                          // queued run uses HSM-adaptive procs.
                          if (!effectiveMatrix) return;
                          queue({ ...s, matrix: effectiveMatrix });
                        } else {
                          queue(s);
                        }
                      }}
                      title={cardTitle}
                    >
                      + 큐에 추가
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="diag" />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.6rem' }}>
            <span className="eyebrow">Custom matrix</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--ink-400)' }}>
              직접 6축을 골라 실행하기
            </span>
          </div>
          <MatrixSelector onChange={setMatrix} />

          <fieldset
            id="loader-creds"
            style={{
              marginTop: '1.5rem',
              borderColor: credsReady ? 'var(--glass-edge)' : 'rgba(255,184,107,0.45)',
              boxShadow: credsReady ? undefined : '0 0 0 1px rgba(255,184,107,0.25), 0 0 24px -8px rgba(255,184,107,0.4)',
              transition: 'border-color 0.4s, box-shadow 0.4s',
            }}
          >
            <legend style={{ color: credsReady ? 'var(--aurora-teal)' : 'var(--aurora-amber)' }}>
              Loader binary 검증 · NFR-3.5{credsReady ? ' ✓' : ' (필수)'}
            </legend>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <label>
                Expected S3 versionId
                <input value={versionId} onChange={(e) => setVersionId(e.target.value)} placeholder="e.g. tHJWp7..." />
              </label>
              <label>
                Expected SHA-256
                <input value={sha256} onChange={(e) => setSha256(e.target.value)} placeholder="64 hex chars" />
              </label>
              <label>
                Worker count override · 선택 (16–1024)
                <input
                  type="number"
                  min={16}
                  max={1024}
                  step={1}
                  value={workerCount}
                  onChange={(e) => setWorkerCount(e.target.value)}
                  placeholder="기본값 = 64 (각 process 의 thread 수). saturation sweep 용."
                />
              </label>
              <label>
                Procs override · 선택 (1–16)
                <input
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  value={procsOverride}
                  onChange={(e) => setProcsOverride(e.target.value)}
                  placeholder="기본값 = 시나리오별 자동 (cs=6→12, 5→12, 4→10, 3→8, 2→6). 같은 cell 을 강제로 다른 procs 수로 측정할 때만 입력."
                />
              </label>
            </div>
          </fieldset>
        </section>

        <aside className="card rise d2" style={{ alignSelf: 'start', position: 'sticky', top: '1.5rem' }}>
          <span className="eyebrow">Custom plan</span>
          <h2 className="title" style={{ marginTop: '0.6rem' }}>실행 요약</h2>
          <div className="metric" style={{ marginTop: '1rem' }}>
            <div className="label">Measurement units</div>
            <div className="value">{totalUnits.toLocaleString()}</div>
            <div className="delta">선택된 6축의 곱집합</div>
          </div>
          <div className="diag" />
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.6rem', fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--ink-300)' }}>
            <li>· 1 min warm-up + 5 min measure / unit</li>
            <li>· FIPS · CloudHSM SDK 5</li>
            <li>· OTel throughput · latency · error rate</li>
            <li>· s3://hsm-bmt-results/runs/&lt;runId&gt;/</li>
          </ul>

          {/* 2026-05-26 HOS: Custom matrix starts empty. Only enable the
              start/queue buttons once the operator has explicitly picked at
              least one value on every required axis (algos, modes, payloads,
              clusterSizes). */}
          {(() => {
            const matrixComplete = !!matrix
              && matrix.algorithms.length > 0
              && matrix.modes.length > 0
              && matrix.payloadBytes.length > 0
              && matrix.clusterSizes.length > 0;
            // 2026-05-26 (procs fix): mirror the Custom-HARD card's procs
            // merge (scenarios.ts custom-hard supplies the HSM-adaptive
            // procsByCluster table). The sidebar's "Custom Run 시작" button
            // is a duplicate entry point for the same Custom-HARD scenario,
            // so it must inherit the same procs config — otherwise it lands
            // at start-run with procs=undefined → defaults to 1 → severely
            // under-saturates the HSM cluster.
            const customScenario = SCENARIOS.find((x) => x.id === 'custom-hard');
            const sideMatrix: MatrixSubset | null = (matrix && customScenario)
              ? {
                  ...matrix,
                  procs: customScenario.matrix.procs ?? matrix.procs,
                  procsByCluster: customScenario.matrix.procsByCluster ?? matrix.procsByCluster,
                  procs256: customScenario.matrix.procs256 ?? matrix.procs256,
                  procs1024: customScenario.matrix.procs1024 ?? matrix.procs1024,
                }
              : matrix;
            // Same cluster gating as the scenario cards. Inherit the
            // Custom-HARD scenario's blockReason since this button starts
            // the same scenario.
            const sideBlockReason = customScenario ? scenarioBlockReason(customScenario) : null;
            const startTitle = !matrixComplete
              ? 'algo / mode / payload / cluster size 를 모두 1개 이상 선택하세요'
              : (sideBlockReason ?? (canExecute ? undefined : disabledTitle));
            const sideDisabled = submitting !== null || !matrixComplete || !canExecute || sideBlockReason !== null;
            return (
              <>
                <button
                  className="btn primary"
                  onClick={() => sideMatrix && matrixComplete && start(sideMatrix, 'custom', customScenario)}
                  disabled={sideDisabled}
                  title={startTitle}
                  style={{ marginTop: '1.5rem', width: '100%' }}
                >
                  {submitting === 'custom' ? '시작 중…' : 'Custom Run 시작 →'}
                </button>
                <button
                  className="btn ghost"
                  onClick={() => sideMatrix && matrixComplete && canExecute && enqueue({
                    scenarioId: 'custom',
                    scenarioName: 'Custom matrix',
                    matrix: sideMatrix,
                    expectedLoaderVersionId: versionId,
                    expectedLoaderSha256: sha256,
                  }) && setEnqueueNotice('Custom matrix 큐에 추가됨')}
                  disabled={sideDisabled}
                  title={startTitle}
                  style={{ marginTop: '0.5rem', width: '100%' }}
                >
                  + Custom을 큐에 추가
                </button>
              </>
            );
          })()}

          {result && (
            <p style={{ color: 'var(--aurora-teal)', marginTop: '1rem', fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
              Run <strong>{result}</strong> 시작됨…
            </p>
          )}
          {enqueueNotice && (
            <p style={{ color: 'var(--aurora-cyan)', marginTop: '1rem', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
              {enqueueNotice}
            </p>
          )}
          {error && <p style={{ color: 'var(--signal-bad)', marginTop: '1rem' }}>{error}</p>}
        </aside>
      </div>
    </>
  );
}
