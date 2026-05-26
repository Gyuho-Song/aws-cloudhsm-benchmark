'use client';

import { useEffect, useState } from 'react';
import { api, RunSummary } from '@/lib/apiClient';

const AMG_DOMAIN = process.env.NEXT_PUBLIC_AMG_WORKSPACE_URL ?? '';

export default function MonitorPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.listRuns()
        .then((r) => { if (alive) setRuns(r.runs ?? []); })
        .catch((e) => { if (alive) setError(String(e)); });
    };
    load();
    const handle = setInterval(() => { setTick((t) => t + 1); load(); }, 10_000);
    return () => { alive = false; clearInterval(handle); };
  }, []);

  const active = runs.filter((r) => r.status === 'RUNNING' || r.status === 'PENDING');
  const completedRuns = runs.filter((r) => r.status === 'COMPLETED');
  const failedRuns = runs.filter((r) => r.status === 'FAILED' || r.status === 'ABORTED');
  const totalUnits = runs.reduce((acc, r) => acc + (r.totalUnits ?? 0), 0);
  const completedUnits = runs.reduce((acc, r) => acc + (r.completedUnits ?? 0), 0);
  const fleetPct = totalUnits ? Math.round((completedUnits / totalUnits) * 1000) / 10 : 0;

  const amgRoot = AMG_DOMAIN.replace(/\/$/, '');
  const primaryUrl = AMG_DOMAIN ? `${amgRoot}/d/hsm-bmt-live-run?kiosk=tv` : '';

  return (
    <>
      <section className="page-head rise">
        <div>
          <span className="eyebrow">Fleet · cross-run telemetry</span>
          <h1 className="display"><em>오로라</em> 모니터링</h1>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <span className="session" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--ink-400)' }}>
            <span className="pill live">refresh 10s · tick {tick}</span>
          </span>
          <a className="btn ghost" href="/">← 콘솔</a>
        </div>
      </section>

      {error && <div className="card" style={{ color: 'var(--signal-bad)' }}>{error}</div>}

      <section className="metric-grid rise d1">
        <div className="metric">
          <div className="label">Active runs</div>
          <div className="value">{active.length}<span className="unit">/ {runs.length}</span></div>
          <div className="delta">RUNNING · PENDING</div>
        </div>
        <div className="metric good">
          <div className="label">Fleet progress</div>
          <div className="value">{fleetPct}<span className="unit">%</span></div>
          <div className="delta">{completedUnits.toLocaleString()} / {totalUnits.toLocaleString()} units</div>
        </div>
        <div className="metric">
          <div className="label">Completed runs</div>
          <div className="value">{completedRuns.length}</div>
          <div className="delta">전체 완료</div>
        </div>
        <div className="metric bad">
          <div className="label">Failed / aborted</div>
          <div className="value">{failedRuns.length}</div>
          <div className="delta">개입 필요</div>
        </div>
      </section>

      <section className="card rise d2" style={{ marginBottom: '1.5rem' }}>
        <h2 className="title">Active runs</h2>
        <p className="lede">
          진행 중인 run의 라이브 진행률. 카드 클릭 시 라이브 콘솔로 이동합니다.
        </p>
        {active.length === 0 ? (
          <p style={{ color: 'var(--ink-300)' }}>현재 진행 중인 run이 없습니다.</p>
        ) : (
          <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {active.map((r) => {
              const pct = r.totalUnits ? Math.round((r.completedUnits / r.totalUnits) * 100) : 0;
              return (
                <a
                  key={r.runId}
                  href={`/runs/${r.runId}/live`}
                  className="card"
                  style={{ display: 'block', textDecoration: 'none', color: 'inherit', padding: '1.2rem 1.3rem' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
                    <span className={`chip ${r.status.toLowerCase()}`}>{r.status}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--ink-400)' }}>
                      {pct}%
                    </span>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--ink-100)', marginBottom: '0.6rem', wordBreak: 'break-all' }}>
                    {r.runId}
                  </div>
                  <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--ink-300)' }}>
                    <span>{r.completedUnits} / {r.totalUnits}</span>
                    <span>{r.createdBy}</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </section>

      <section className="card rise d3">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <span className="eyebrow">AMG · Grafana 대시보드</span>
            <h2 className="title" style={{ marginTop: '0.6rem' }}>실시간 메트릭</h2>
            <p className="lede" style={{ marginBottom: 0 }}>
              새 탭에서 IAM Identity Center 인증 후 Throughput · Latency · Error rate 시계열을 확인합니다.
            </p>
          </div>
          {primaryUrl ? (
            <a className="btn primary" href={primaryUrl} target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>
              Live Run 보드 열기 ↗
            </a>
          ) : (
            <span style={{ color: 'var(--signal-bad)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>AMG URL 미설정</span>
          )}
        </div>
      </section>
    </>
  );
}
