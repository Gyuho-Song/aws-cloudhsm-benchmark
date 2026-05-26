'use client';

import { useEffect, useRef, useState } from 'react';
import { api, consumePostLoginPath } from '@/lib/apiClient';
import { isAuthenticated, login, logout, exchangeCodeForToken, scheduleRefresh } from '@/lib/auth';
import {
  loadQueue, saveQueue, subscribe, removeItem, updateItem, clearAll,
  isTerminal, QueueItem,
} from '@/lib/queue';
import { isViewer } from '@/lib/groups';

interface Run {
  runId: string;
  status: string;
  startedAt: string;
  completedUnits: number;
  totalUnits: number;
  createdBy: string;
}

const statusClass = (s: string) => s.toLowerCase();

/** Runs created before the v3-final scenarios cutover are sweep-harness or
 * exploratory measurement runs that the operator no longer wants surfaced
 * in the main console. Hide them by default; show via the "Show hidden"
 * toggle for debug/audit. Real scenario runs are kept visible regardless. */
const HIDE_BEFORE_ISO = '2026-05-18T17:00:00Z';
const SHARD_CREATEDBY_PREFIXES = ['mpsk-', 'msw-', 'jsw-', 'sw-', 'mp4-', 'mp-'];
function isShardOrLegacy(r: Run): boolean {
  // Sweep-harness shards (multi-process measurement plumbing).
  if (r.createdBy && SHARD_CREATEDBY_PREFIXES.some((p) => r.createdBy.startsWith(p))) return true;
  // Pre-cutover runs.
  if (r.startedAt && r.startedAt < HIDE_BEFORE_ISO) return true;
  return false;
}

export default function OverviewPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  // U-CH-3: viewer 계정은 큐 자동 실행 / clear / 삭제 / 새 Run 등 mutating
  // 동작 모두 disabled. backend authorizer 가 최종 게이트.
  const [viewerMode, setViewerMode] = useState(false);
  // FR-CH-1.4 exact wording
  const viewerTooltip = '조회 권한입니다. 실행은 admin 으로 로그인하세요.';
  const startingRef = useRef(false);

  // ---- auth + callback handling -------------------------------------------
  useEffect(() => {
    const path = window.location.pathname;
    const code = new URLSearchParams(window.location.search).get('code');
    if (path.startsWith('/callback') && code) {
      setAuthBusy(true);
      exchangeCodeForToken(code)
        .then(() => {
          // Resume where the user was before the 401-driven re-auth.
          const resume = consumePostLoginPath();
          if (resume && resume !== '/') {
            window.location.replace(resume);
          } else {
            window.history.replaceState({}, '', '/');
            setAuthed(true);
          }
        })
        .catch((e) => setError(`로그인 실패: ${String(e)}`))
        .finally(() => setAuthBusy(false));
      return;
    }
    setAuthed(isAuthenticated());
    scheduleRefresh();
    setViewerMode(isViewer());
  }, []);

  // ---- queue subscription -------------------------------------------------
  useEffect(() => {
    setQueue(loadQueue());
    return subscribe(() => setQueue(loadQueue()));
  }, []);

  // ---- runs polling -------------------------------------------------------
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    const tick = () => {
      api.listRuns()
        .then((r) => { if (alive) setRuns((r.runs as Run[]) ?? []); })
        .catch((e) => { if (alive) setError(String(e)); });
    };
    tick();
    const handle = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(handle); };
  }, [authed]);

  // ---- auto-runner: drive queue head --------------------------------------
  useEffect(() => {
    if (!authed || !autoRun || startingRef.current) return;
    if (viewerMode) return;        // U-CH-3: viewer 는 큐 head 진행 안 함
    if (queue.length === 0) return;
    const head = queue[0];

    // Update head's status from the latest runs poll
    if (head.runId) {
      const live = runs.find((r) => r.runId === head.runId);
      if (live) {
        const s = live.status.toLowerCase() as QueueItem['status'];
        if (head.status !== s) updateItem(head.id, { status: s });
        if (isTerminal(s)) {
          // pop head; next render's effect will start the next item
          removeItem(head.id);
        }
      }
      return;
    }

    // No runId yet — start it
    startingRef.current = true;
    api.startRun({
      matrixSubset: head.matrix,
      expectedLoaderVersionId: head.expectedLoaderVersionId,
      expectedLoaderSha256: head.expectedLoaderSha256,
    })
      .then((r) => updateItem(head.id, { runId: r.runId, status: 'starting' }))
      .catch((e) => {
        updateItem(head.id, { status: 'failed' });
        setError(`큐 head 실행 실패: ${String(e)}`);
      })
      .finally(() => { startingRef.current = false; });
  }, [authed, autoRun, queue, runs, viewerMode]);

  // ---- gate ---------------------------------------------------------------
  if (!authed) {
    return (
      <div className="rise" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <div className="card" style={{ maxWidth: 480, textAlign: 'center' }}>
          <span className="eyebrow">Restricted Surface</span>
          <h2 className="title" style={{ fontSize: '2rem', marginTop: '0.6rem' }}>
            Step into the <em style={{ fontStyle: 'italic' }}>aurora</em>.
          </h2>
          <p className="lede">
            {authBusy ? 'Cognito 토큰 교환 중…'
              : '오로라 콘솔은 운영자 전용입니다. Cognito Hosted UI로 인증하세요.'}
          </p>
          {!authBusy && (
            <button className="btn primary" onClick={login} style={{ marginTop: '0.5rem' }}>
              Cognito로 로그인 →
            </button>
          )}
          {error && <p style={{ color: 'var(--signal-bad)', marginTop: '1rem' }}>{error}</p>}
        </div>
      </div>
    );
  }

  // ---- summary metrics ----------------------------------------------------
  const totalActive = runs.filter((r) => r.status === 'RUNNING' || r.status === 'PENDING').length;
  const totalCompleted = runs.filter((r) => r.status === 'COMPLETED').length;
  const aggregateUnits = runs.reduce((acc, r) => acc + r.completedUnits, 0);

  return (
    <>
      <section className="page-head rise">
        <div>
          <span className="eyebrow">Mission control · {viewerMode ? '조회 전용' : '운영자 콘솔'}</span>
          <h1 className="display">Run <em>fleet</em> overview</h1>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <a className="btn ghost" href="/monitor">Fleet monitor</a>
          {viewerMode ? (
            <span
              className="btn primary"
              aria-disabled="true"
              title={viewerTooltip}
              style={{ opacity: 0.45, pointerEvents: 'none' }}
            >
              + 새 Run / 시나리오
            </span>
          ) : (
            <a className="btn primary" href="/runs/new">+ 새 Run / 시나리오</a>
          )}
          <button className="btn ghost" onClick={logout}>Logout</button>
        </div>
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
          조회 전용 계정으로 로그인되어 있습니다. Run 실행 / 큐 관리 / 중단 버튼은 비활성화됩니다.
        </div>
      )}

      {queue.length > 0 && (
        <section className="card rise d1" style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.8rem' }}>
            <div>
              <span className="eyebrow">Queue · {queue.length} pending</span>
              <h2 className="title" style={{ marginTop: '0.4rem' }}>시나리오 큐</h2>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem', textTransform: 'none', letterSpacing: 0, fontSize: '0.8rem', color: 'var(--ink-200)', fontFamily: 'var(--font-ui)' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto', accentColor: 'var(--aurora-teal)' }}
                  checked={autoRun}
                  onChange={(e) => setAutoRun(e.target.checked)}
                  disabled={viewerMode}
                  title={viewerMode ? viewerTooltip : undefined}
                />
                자동 순차 실행
              </label>
              <button
                className="btn danger"
                onClick={clearAll}
                disabled={viewerMode}
                title={viewerMode ? viewerTooltip : undefined}
              >
                큐 비우기
              </button>
            </div>
          </div>
          <table className="runs">
            <thead>
              <tr>
                <th>#</th><th>Scenario</th><th>Run</th><th>Status</th><th>Enqueued</th><th></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((q, i) => (
                <tr key={q.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-400)' }}>{i === 0 ? '▶' : i}</td>
                  <td style={{ fontFamily: 'var(--font-display)' }}>{q.scenarioName}</td>
                  <td>
                    {q.runId
                      ? <a href={`/runs/${q.runId}/live`}>{q.runId}</a>
                      : <span style={{ color: 'var(--ink-400)' }}>대기</span>}
                  </td>
                  <td>
                    <span className={`chip ${q.status ?? 'queued'}`}>
                      {(q.status ?? 'queued').toUpperCase()}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--ink-300)' }}>
                    {q.enqueuedAt.replace('T', ' ').replace(/\..+$/, '')}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn ghost"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.78rem' }}
                      onClick={() => removeItem(q.id)}
                      disabled={viewerMode}
                      title={viewerMode ? viewerTooltip : undefined}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!autoRun && (
            <p style={{ color: 'var(--ink-300)', marginTop: '0.8rem', fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}>
              자동 순차 실행이 꺼져있습니다. head 항목은 아무도 시작하지 않습니다.
            </p>
          )}
        </section>
      )}

      <section className="metric-grid rise d2">
        <div className="metric">
          <div className="label">Active runs</div>
          <div className="value">{totalActive}<span className="unit">/ {runs.length}</span></div>
          <div className="delta">RUNNING · PENDING</div>
        </div>
        <div className="metric good">
          <div className="label">Completed</div>
          <div className="value">{totalCompleted}</div>
          <div className="delta">전체 완료된 run</div>
        </div>
        <div className="metric">
          <div className="label">Units logged</div>
          <div className="value">{aggregateUnits.toLocaleString()}</div>
          <div className="delta">measurement units 누적</div>
        </div>
        <div className="metric">
          <div className="label">Cluster</div>
          <div className="value" style={{ fontSize: '1.5rem' }}>6 × hsm2m.medium</div>
          <div className="delta">FIPS · ap-northeast-2 a/b/c/d</div>
        </div>
      </section>

      <section className="card rise d3">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.6rem' }}>
          <div>
            <h2 className="title">최근 Run</h2>
            <p className="lede" style={{ marginBottom: 0 }}>
              시간 역순. Run ID 클릭 시 라이브 / 결과 / 보고서 페이지로 이동합니다.
            </p>
          </div>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem', textTransform: 'none', letterSpacing: 0, fontSize: '0.8rem', color: 'var(--ink-300)', fontFamily: 'var(--font-ui)' }}>
            <input
              type="checkbox"
              style={{ width: 'auto', accentColor: 'var(--aurora-teal)' }}
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden (sweep / legacy)
          </label>
        </div>
        {error && <p style={{ color: 'var(--signal-bad)' }}>{error}</p>}
        {(() => {
          const visible = showHidden ? runs : runs.filter((r) => !isShardOrLegacy(r));
          const hiddenCount = runs.length - visible.length;
          if (visible.length === 0 && !error) {
            return <p style={{ color: 'var(--ink-300)' }}>
              {runs.length === 0 ? '아직 시작된 run이 없습니다.' : `${hiddenCount}개의 sweep/legacy run이 숨겨져 있습니다. 우측 상단 토글로 표시.`}
            </p>;
          }
          return (
          <>
          {hiddenCount > 0 && (
            <p style={{ color: 'var(--ink-400)', fontFamily: 'var(--font-mono)', fontSize: '0.78rem', margin: '0.4rem 0 0.6rem' }}>
              {hiddenCount}개 sweep/legacy run 숨김 (toggle to view)
            </p>
          )}
          <table className="runs">
            <thead>
              <tr>
                <th>Run ID</th><th>Status</th><th>Started</th><th>Progress</th><th>Operator</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const pct = r.totalUnits ? Math.round((r.completedUnits / r.totalUnits) * 100) : 0;
                return (
                  <tr key={r.runId}>
                    <td><a href={`/runs/${r.runId}/live`}>{r.runId}</a></td>
                    <td><span className={`chip ${statusClass(r.status)}`}>{r.status}</span></td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--ink-300)' }}>{r.startedAt}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', minWidth: 220 }}>
                        <div className="bar" style={{ flex: 1 }}><i style={{ width: `${pct}%` }} /></div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--ink-300)' }}>
                          {r.completedUnits} / {r.totalUnits}
                        </span>
                      </div>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>{r.createdBy}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </>
          );
        })()}
      </section>
    </>
  );
}
