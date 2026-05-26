'use client';

import { useRunIdFromUrl } from '@/lib/runId';

const AMG_DOMAIN = process.env.NEXT_PUBLIC_AMG_WORKSPACE_URL ?? '';

export default function DashboardPage() {
  const params = { id: useRunIdFromUrl() };
  const liveRunUrl = AMG_DOMAIN
    ? `${AMG_DOMAIN.replace(/\/$/, '')}/d/hsm-bmt-live-run?var-runId=${encodeURIComponent(params.id)}&kiosk=tv`
    : '';
  return (
    <>
      <section className="page-head rise">
        <div>
          <span className="eyebrow">Grafana · live observability</span>
          <h1 className="display"><em>실시간</em> 대시보드</h1>
        </div>
        <a className="btn ghost" href={`/runs/${params.id}/live`}>← Live</a>
      </section>
      <section className="card rise d1" style={{ display: 'grid', placeItems: 'center', minHeight: '50vh', textAlign: 'center', padding: '3rem 2rem' }}>
        <div style={{ maxWidth: 540 }}>
          <span className="eyebrow">Run · {params.id}</span>
          <h2 className="title" style={{ fontSize: '2rem', marginTop: '0.6rem' }}>
            대시보드는 <em>새 탭</em>에서 열립니다.
          </h2>
          <p className="lede">
            AWS Managed Grafana는 보안 정책상 iframe 임베드를 차단합니다 (X-Frame-Options: deny).
            새 탭으로 이동해 IAM Identity Center 인증 후 이 run의 라이브 메트릭을 확인하세요.
          </p>
          {liveRunUrl ? (
            <a className="btn primary" href={liveRunUrl} target="_blank" rel="noreferrer" style={{ marginTop: '0.5rem' }}>
              Grafana로 이동 ↗
            </a>
          ) : (
            <p style={{ color: 'var(--signal-bad)' }}>NEXT_PUBLIC_AMG_WORKSPACE_URL 미설정</p>
          )}
        </div>
      </section>
    </>
  );
}
