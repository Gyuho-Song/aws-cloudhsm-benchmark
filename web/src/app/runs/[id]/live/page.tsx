'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/apiClient';
import { useRunIdFromUrl } from '@/lib/runId';
import { isViewer } from '@/lib/groups';

interface Status {
  runId: string;
  status: string;
  completed: number;
  total: number;
  etaUtc: string | null;
  completedAt?: string | null;
}

const TERMINAL_STATUSES = ['COMPLETED', 'ABORTED', 'FAILED'];

export default function LiveStatusPage() {
  const params = { id: useRunIdFromUrl() };
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  // U-CH-3 viewer 게이트
  const [viewerMode, setViewerMode] = useState(false);
  useEffect(() => { setViewerMode(isViewer()); }, []);
  // FR-CH-1.4 exact wording
  const viewerTooltip = '조회 권한입니다. 실행은 admin 으로 로그인하세요.';

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.getRunStatus(params.id);
        if (alive) setStatus(s);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    tick();
    const handle = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(handle); };
  }, [params.id]);

  const abort = async () => {
    if (!confirm(`정말 ${params.id}을(를) 중단하시겠습니까?`)) return;
    await api.abortRun(params.id);
  };

  if (error) {
    return <div className="card" style={{ color: 'var(--signal-bad)' }}>{error}</div>;
  }
  if (!status) return <p style={{ color: 'var(--ink-300)' }}>오로라 동기화 중…</p>;

  const pct = status.total ? (status.completed / status.total) * 100 : 0;

  return (
    <>
      <section className="page-head rise">
        <div>
          <span className="eyebrow">Live · {status.status}</span>
          <h1 className="display">
            <em>{params.id}</em>
          </h1>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <a className="btn ghost" href={`/runs/${params.id}/dashboard`}>대시보드 →</a>
          <a className="btn ghost" href={`/runs/${params.id}/results`}>결과 →</a>
          <a className="btn ghost" href={`/runs/${params.id}/report`}>보고서 →</a>
        </div>
      </section>

      <div className="layout-split">
        <section className="card rise d1" style={{ display: 'grid', placeItems: 'center', minHeight: 360 }}>
          <div className="arc" style={{ ['--pct' as never]: pct } as React.CSSProperties}>
            <div className="num">
              {pct.toFixed(1)}<small>%</small>
            </div>
            <div className="caption">progress</div>
          </div>
          <div style={{ marginTop: '1.5rem', display: 'flex', gap: '2rem', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--ink-300)', justifyContent: 'center' }}>
            <span>{status.completed.toLocaleString()} <small style={{ color: 'var(--ink-400)' }}>completed</small></span>
            <span>{(status.total - status.completed).toLocaleString()} <small style={{ color: 'var(--ink-400)' }}>remaining</small></span>
            <span>{status.total.toLocaleString()} <small style={{ color: 'var(--ink-400)' }}>total</small></span>
          </div>
        </section>

        <aside className="card rise d2">
          <span className="eyebrow">Telemetry</span>
          <h2 className="title" style={{ marginTop: '0.6rem' }}>상태</h2>
          <div className="metric" style={{ marginTop: '1rem' }}>
            <div className="label">Status</div>
            <div className="value" style={{ fontSize: '1.6rem' }}>
              <span className={`chip ${status.status.toLowerCase()}`} style={{ fontSize: '0.8rem', padding: '0.35rem 0.8rem' }}>
                {status.status}
              </span>
            </div>
          </div>
          {TERMINAL_STATUSES.includes(status.status) ? (
            <div className="metric" style={{ marginTop: '0.75rem' }}>
              <div className="label">종료 (UTC)</div>
              <div className="value" style={{ fontSize: '1.4rem', fontFamily: 'var(--font-mono)' }}>
                {status.completedAt ?? '—'}
              </div>
            </div>
          ) : (
            <div className="metric" style={{ marginTop: '0.75rem' }}>
              <div className="label">ETA (UTC)</div>
              <div className="value" style={{ fontSize: '1.4rem', fontFamily: 'var(--font-mono)' }}>
                {status.etaUtc ?? '계산 중…'}
              </div>
            </div>
          )}
          {(status.status === 'RUNNING' || status.status === 'PENDING') && (
            <button
              className="btn danger"
              onClick={abort}
              disabled={viewerMode}
              title={viewerMode ? viewerTooltip : undefined}
              style={{ marginTop: '1.25rem', width: '100%' }}
            >
              ◼ Run 중단
            </button>
          )}
        </aside>
      </div>
    </>
  );
}
