'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/apiClient';
import { useRunIdFromUrl } from '@/lib/runId';

type Phase = 'loading' | 'not_ready' | 'ready' | 'error';

export default function ReportPage() {
  const runId = useRunIdFromUrl();
  const [phase, setPhase] = useState<Phase>('loading');
  const [htmlUrl, setHtmlUrl] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };

    const probe = () => {
      Promise.all([api.reportHtmlUrl(runId), api.reportPdfUrl(runId)])
        .then(([h, p]) => {
          if (!alive) return;
          // status field is optional for backwards-compat — treat presence of url as READY.
          const ready = (h.status === 'READY' || (!h.status && !!h.url));
          if (ready && h.url) {
            setHtmlUrl(h.url);
            setPdfUrl(p.url ?? null);
            setPhase('ready');
            stopPolling();
          } else {
            setPendingMsg(h.message ?? '테스트가 완료된 후 보고서가 제공됩니다.');
            setPhase('not_ready');
          }
        })
        .catch((e) => {
          if (!alive) return;
          setErrorMsg(String(e));
          setPhase('error');
          stopPolling();
        });
    };

    probe();
    // Self-heal poll once the run finishes; probe stops the interval the
    // moment we transition to ready/error so we do not spin forever.
    timer = setInterval(probe, 30000);
    return () => { alive = false; stopPolling(); };
  }, [runId]);

  return (
    <>
      <section className="page-head rise">
        <div>
          <span className="eyebrow">Korean report · 한국어 보고서</span>
          <h1 className="display"><em>{runId}</em></h1>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <a className="btn ghost" href={`/runs/${runId}/live`}>← Live</a>
          {pdfUrl
            ? <a className="btn primary" href={pdfUrl} target="_blank" rel="noreferrer">PDF 다운로드 ↓</a>
            : <button className="btn primary" disabled>PDF 다운로드 ↓</button>}
        </div>
      </section>
      <section className="card rise d1" style={{ padding: '0.75rem' }}>
        {phase === 'loading' && (
          <p style={{ color: 'var(--ink-300)' }}>보고서 상태 확인 중…</p>
        )}
        {phase === 'not_ready' && (
          <div style={{ padding: '1.5rem 1rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--ink-100)', fontSize: '1.05rem', marginBottom: '0.4rem' }}>
              {pendingMsg ?? '테스트가 완료된 후 보고서가 제공됩니다.'}
            </p>
            <p style={{ color: 'var(--ink-300)', fontSize: '0.85rem' }}>
              실시간 진행 상황은 <a href={`/runs/${runId}/live`} style={{ color: 'var(--accent)' }}>Live 페이지</a>에서 확인하실 수 있습니다.
            </p>
          </div>
        )}
        {phase === 'error' && (
          <p style={{ color: 'var(--signal-bad)', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
            보고서 URL을 불러올 수 없습니다: {errorMsg}
          </p>
        )}
        {phase === 'ready' && htmlUrl && (
          <iframe
            title="Korean BMT report"
            src={htmlUrl}
            style={{ width: '100%', height: '80vh', border: 0, borderRadius: 14, background: '#0a0d1a' }}
          />
        )}
      </section>
    </>
  );
}
