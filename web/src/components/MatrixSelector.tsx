'use client';

import { useState } from 'react';
export type { MatrixSubset } from '@/lib/matrix';
import type { MatrixSubset } from '@/lib/matrix';

// 2026-05-25 HOS: only PER_CALL_RAW is supported in HARD-only scenarios.
// V3 / PER_CALL kept in the type system for legacy DDB row reads but
// removed from the selector UI.
const FAMILIES = ['PER_CALL_RAW'] as const;
const ALGOS = ['AES_128', 'AES_256'] as const;
const MODES = ['ECB', 'CBC', 'CTR', 'GCM', 'CMAC'] as const;
const PAYLOADS = [256, 1024] as const;
const SIZES = [2, 3, 4, 5, 6] as const;
const VARIANTS = ['A', 'B'] as const;

export interface MatrixSelectorProps {
  initial?: Partial<MatrixSubset>;
  onChange: (s: MatrixSubset) => void;
}

function toggle<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

const chipStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0.45rem 0.95rem',
  borderRadius: 999,
  border: `1px solid ${active ? 'rgba(160,125,255,0.55)' : 'var(--glass-edge)'}`,
  background: active
    ? 'linear-gradient(120deg, rgba(160,125,255,0.22), rgba(93,184,255,0.22))'
    : 'rgba(255,255,255,0.025)',
  color: active ? 'var(--ink-100)' : 'var(--ink-300)',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.78rem',
  letterSpacing: '0.05em',
  cursor: 'pointer',
  transition: 'all 0.25s',
  userSelect: 'none',
});

export default function MatrixSelector({ initial, onChange }: MatrixSelectorProps) {
  // 2026-05-26: empty-by-default so a stray click on Custom doesn't fire a
  // full sweep. Family is the one exception — there's only one valid value
  // (PER_CALL_RAW) in HOS, so prefilling it is harmless.
  const [families, setFamilies] = useState<MatrixSubset['families']>(initial?.families ?? ['PER_CALL_RAW']);
  const [algos, setAlgos] = useState<MatrixSubset['algorithms']>(initial?.algorithms ?? []);
  const [modes, setModes] = useState<MatrixSubset['modes']>(initial?.modes ?? []);
  const [payloads, setPayloads] = useState<MatrixSubset['payloadBytes']>(initial?.payloadBytes ?? []);
  const [sizes, setSizes] = useState<MatrixSubset['clusterSizes']>(initial?.clusterSizes ?? []);
  const [variants, setVariants] = useState<MatrixSubset['variants']>(initial?.variants ?? []);

  const emit = (next: Partial<MatrixSubset>) => {
    // 2026-05-25 HOS: Custom matrix is always HARD scale.
    // 2026-05-26: Custom is single-cluster-size only (autoScale=false). Multi-
    // size sweeps belong to the PER_CALL Full preset, which has its own QA-ed
    // cluster ordering and timing budget. Allowing arbitrary multi-size in
    // Custom invited operator footguns (e.g. 6→2→3 ordering wastes scale-up
    // time) for no real measurement benefit — anyone who wants multi-size
    // already has Full HARD.
    onChange({
      families,
      algorithms: algos,
      modes,
      payloadBytes: payloads,
      clusterSizes: sizes,
      variants,
      runner: 'c-native-multiproc',
      hardScale: true,
      autoScale: false,
      ...next,
    });
  };

  const renderRow = <T,>(
    title: string,
    note: string,
    items: readonly T[],
    current: readonly T[],
    setter: (next: T[]) => void,
    emitKey: keyof MatrixSubset,
  ) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) 1fr', gap: '1.5rem', alignItems: 'start', padding: '1rem 0', borderBottom: '1px solid var(--glass-edge)' }}>
      <div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--aurora-teal)' }}>{title}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--ink-400)', marginTop: '0.4rem' }}>{note}</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {items.map((v) => {
          const active = current.includes(v);
          return (
            <button
              key={String(v)}
              type="button"
              style={chipStyle(active)}
              onClick={() => {
                const next = toggle(current, v) as T[];
                setter(next);
                emit({ [emitKey]: next as unknown } as Partial<MatrixSubset>);
              }}
            >
              {String(v)}
            </button>
          );
        })}
      </div>
    </div>
  );

  // 2026-05-26: Cluster row is single-select (radio-style). Picking N replaces
  // the previous selection rather than toggling — Custom only ever runs one
  // cluster size per Run.
  const pickClusterSize = (v: typeof SIZES[number]) => {
    const next: typeof SIZES[number][] = sizes[0] === v ? [] : [v];
    setSizes(next);
    emit({ clusterSizes: next });
  };

  return (
    <div data-testid="matrix-selector">
      {renderRow('Family',     '단일 family (PER_CALL_RAW)',     FAMILIES, families as readonly typeof FAMILIES[number][], setFamilies as (n: typeof FAMILIES[number][]) => void, 'families')}
      {renderRow('Algorithm',  'AES key length',                 ALGOS,    algos,    setAlgos    as (n: typeof ALGOS[number][])    => void, 'algorithms')}
      {renderRow('Mode',       'PER_CALL family에만 적용',        MODES,    modes,    setModes    as (n: typeof MODES[number][])    => void, 'modes')}
      {renderRow('Payload',    'plaintext 길이 (bytes)',          PAYLOADS, payloads, setPayloads as (n: typeof PAYLOADS[number][]) => void, 'payloadBytes')}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) 1fr', gap: '1.5rem', alignItems: 'start', padding: '1rem 0', borderBottom: '1px solid var(--glass-edge)' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--aurora-teal)' }}>Cluster</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--ink-400)', marginTop: '0.4rem' }}>HSM 갯수 — Custom 은 단일 size 만 (sweep 은 Full preset 사용)</div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {SIZES.map((v) => {
            const active = sizes[0] === v;
            return (
              <button
                key={String(v)}
                type="button"
                style={chipStyle(active)}
                onClick={() => pickClusterSize(v)}
              >
                {String(v)}
              </button>
            );
          })}
        </div>
      </div>
      {/* Variant row removed — V3-only field (HOS retired V3 family). */}
    </div>
  );
}
