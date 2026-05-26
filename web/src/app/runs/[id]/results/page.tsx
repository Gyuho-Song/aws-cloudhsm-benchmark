'use client';

import { useEffect, useState } from 'react';
import { api, RunSummary, UnitRow } from '@/lib/apiClient';
import { failedUnits, matrixFromUnits, countUnits } from '@/lib/matrix';
import { useRunIdFromUrl } from '@/lib/runId';

export default function ResultsPage() {
  const params = { id: useRunIdFromUrl() };
  const [run, setRun] = useState<RunSummary | null>(null);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | 'clone' | 'retry'>(null);
  const [pickedFailedOnly, setPickedFailedOnly] = useState(false);

  useEffect(() => {
    api.getRun(params.id)
      .then((r) => { setRun(r.run); setUnits(r.units ?? []); })
      .catch((e) => setError(String(e)));
  }, [params.id]);

  const failed = failedUnits(units);
  const completed = units.filter((u) => u.status === 'COMPLETED').length;

  const reSubmit = async (mode: 'clone' | 'retry') => {
    if (!run) return;
    if (mode === 'retry' && failed.length === 0) return;
    if (mode === 'clone' && units.length === 0 && !run.matrixSubset) {
      setError('재실행할 단위가 없습니다 (units=0 + matrixSubset 누락).');
      return;
    }
    setSubmitting(mode);
    try {
      const matrix = mode === 'clone'
        ? (run.matrixSubset ?? matrixFromUnits(units))
        : matrixFromUnits(failed);
      // 2026-05-26: defense-in-depth. matrixFromUnits() filters out empty/'-'
      // mode tags (legacy V3 rows), so a run made entirely of V3 units would
      // give modes=[]. Backend rejects this with 400 — show the operator a
      // clearer message before the round-trip.
      if (!matrix.algorithms.length || !matrix.payloadBytes.length || !matrix.clusterSizes.length) {
        setError('이 run 의 unit 데이터로는 matrix 를 재구성할 수 없습니다 (algo/payload/cluster size 누락).');
        return;
      }
      if (matrix.families.includes('PER_CALL_RAW') && matrix.modes.length === 0) {
        setError('PER_CALL_RAW 매트릭스 재구성 실패 (mode 누락). Custom 시나리오에서 직접 선택해 주세요.');
        return;
      }
      const r = await api.startRun({
        matrixSubset: matrix,
        expectedLoaderVersionId: run.expectedLoaderVersionId ?? '',
        expectedLoaderSha256: run.expectedLoaderSha256 ?? '',
      });
      window.location.href = `/runs/${r.runId}/live`;
    } catch (e) {
      setError(String(e));
      setSubmitting(null);
    }
  };

  const previewMatrix = pickedFailedOnly && failed.length
    ? matrixFromUnits(failed)
    : run?.matrixSubset ?? (units.length ? matrixFromUnits(units) : null);

  return (
    <>
      <section className="page-head rise">
        <div>
          <span className="eyebrow">Measurements · per-unit</span>
          <h1 className="display"><em>{params.id}</em> · 결과</h1>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <a className="btn ghost" href={`/runs/${params.id}/live`}>← Live</a>
          <a className="btn ghost" href="/monitor">Monitor</a>
          <a className="btn primary" href={`/runs/${params.id}/report`}>한국어 보고서 →</a>
        </div>
      </section>

      {error && <div className="card" style={{ color: 'var(--signal-bad)' }}>{error}</div>}

      <section className="card rise d1" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
          <div className="metric good">
            <div className="label">Completed</div>
            <div className="value">{completed}</div>
            <div className="delta">/ {units.length} units</div>
          </div>
          <div className="metric bad">
            <div className="label">Failed</div>
            <div className="value">{failed.length}</div>
            <div className="delta">FAILED · TIMEOUT · ABORTED</div>
          </div>
          <div className="metric">
            <div className="label">Re-run plan</div>
            <div className="value" style={{ fontSize: '1.6rem' }}>
              {previewMatrix ? countUnits(previewMatrix).toLocaleString() : '–'}
              <span className="unit">units</span>
            </div>
            <div className="delta">{pickedFailedOnly ? 'failed only' : 'full clone'}</div>
          </div>
          <div className="metric">
            <div className="label">Operator</div>
            <div className="value" style={{ fontSize: '1.1rem', fontFamily: 'var(--font-mono)' }}>
              {run?.createdBy ?? '–'}
            </div>
            <div className="delta">{run?.startedAt ?? ''}</div>
          </div>
        </div>

        <div className="diag" />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <span className="eyebrow" style={{ color: 'var(--ink-300)' }}>Re-run actions</span>
          <button
            className="btn"
            style={{ borderColor: pickedFailedOnly ? 'var(--glass-edge)' : 'rgba(160,125,255,0.45)', background: pickedFailedOnly ? 'transparent' : 'linear-gradient(120deg, rgba(160,125,255,0.18), rgba(93,184,255,0.18))' }}
            onClick={() => setPickedFailedOnly(false)}
          >
            전체 시나리오
          </button>
          <button
            className="btn"
            disabled={failed.length === 0}
            style={{ borderColor: pickedFailedOnly ? 'rgba(160,125,255,0.45)' : 'var(--glass-edge)', background: pickedFailedOnly ? 'linear-gradient(120deg, rgba(160,125,255,0.18), rgba(93,184,255,0.18))' : 'transparent' }}
            onClick={() => setPickedFailedOnly(true)}
          >
            실패 unit만 ({failed.length})
          </button>
          <span style={{ flex: 1 }} />
          <button
            className="btn primary"
            disabled={!run || submitting !== null || (pickedFailedOnly && failed.length === 0)}
            onClick={() => reSubmit(pickedFailedOnly ? 'retry' : 'clone')}
          >
            {submitting === null
              ? (pickedFailedOnly ? '실패 unit 다시 실행 →' : '같은 시나리오 다시 실행 →')
              : '시작 중…'}
          </button>
        </div>
      </section>

      <section className="card rise d2">
        <table className="runs">
          <thead>
            <tr>
              <th>Unit</th><th>Family</th><th>Variant</th>
              <th>Algo</th><th>Mode</th><th>Payload</th><th>Size</th>
              <th>Status</th><th style={{ textAlign: 'right' }}>ops/s</th><th style={{ textAlign: 'right' }}>p99 (ms)</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.unitId}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--ink-200)' }}>{u.unitId}</td>
                <td>{u.family}</td>
                <td>{u.variant}</td>
                <td>{u.algo}</td>
                <td>{u.mode}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{u.payload}</td>
                <td>{u.clusterSize}</td>
                <td><span className={`chip ${u.status.toLowerCase()}`}>{u.status}</span></td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--aurora-teal)' }}>
                  {u.opsPerSec?.toFixed(0) ?? '–'}
                </td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--aurora-cyan)' }}>
                  {u.p99Ns ? (u.p99Ns / 1_000_000).toFixed(2) : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {units.length === 0 && !error && (
          <p style={{ color: 'var(--ink-300)' }}>아직 수집된 measurement이 없습니다.</p>
        )}
      </section>
    </>
  );
}
