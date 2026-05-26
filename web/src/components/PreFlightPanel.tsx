'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ClusterStatus } from '@/lib/apiClient';
import { Scenario, requiredStartHsmCountFor } from '@/lib/scenarios';
import { MatrixSubset } from '@/lib/matrix';
import { isViewer } from '@/lib/groups';

interface Props {
  scenario: Scenario | null;
  /** Effective matrix (may have partialClusterSize override applied). */
  matrix?: MatrixSubset;
  /** Called when canStart transitions from false → true so the parent
   *  can re-enable the "Run 시작" button. */
  onReadyChange?: (ready: boolean) => void;
}

/**
 * Pre-flight readiness panel (HOS-Step10) shown above the run-start button
 * on /runs/new. Compares scenario.requiredStartHsmCount with the current
 * cluster ACTIVE count and offers an in-place provision button.
 *
 * States:
 *   - scaling      → "스케일링 중" 안내, run 시작 차단
 *   - ready        → "✓ 준비 완료"
 *   - need-up      → "+N HSM 프로비저닝 필요" + 버튼
 *   - over         → "현재 N대, 시나리오는 M대만 사용. 그대로 시작 / 축소"
 *   - unknown/api  → 차단 + 재시도 안내
 */
export default function PreFlightPanel({ scenario, matrix, onReadyChange }: Props) {
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [viewerMode, setViewerMode] = useState(true);
  useEffect(() => { setViewerMode(isViewer()); }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getClusterStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = status?.uiState === 'scaling' ? 10_000 : 30_000;
    const id = window.setInterval(refresh, interval);
    return () => window.clearInterval(id);
  }, [refresh, status?.uiState]);

  // 2026-05-26: hooks must run unconditionally and in the same order on
  // every render (React Hooks rules). The previous `if (!scenario) return
  // null` guard sat between two useEffect calls, so a render where
  // scenario was non-null skipped the second useEffect on the next render
  // → "Rendered fewer hooks than expected" crash → client-side exception.
  // Compute derived values defensively (scenario may be null) and put the
  // null guard AFTER all hooks.
  const required = scenario ? requiredStartHsmCountFor(scenario, matrix) : 0;
  const ready = !!status &&
    !!scenario &&
    status.uiState === 'idle' &&
    status.activeCount >= required;

  useEffect(() => {
    onReadyChange?.(ready);
  }, [ready, onReadyChange]);

  if (!scenario) return null;

  if (!status) {
    return (
      <Box color="#9ca3af">
        ⏳ 클러스터 상태 확인 중…
      </Box>
    );
  }

  if (status.uiState === 'unknown') {
    return (
      <Box color="#ef4444">
        🔴 클러스터 상태를 읽을 수 없습니다 (SSM/HSM API 일시 장애?). 잠시 후 다시 시도하세요.
      </Box>
    );
  }

  if (status.uiState === 'scaling') {
    const target = status.scalingTarget ?? status.desiredCount;
    // ETA model: CreateHsm ~25 min, DeleteHsm ~12 min, +5 min mesh stabilize.
    // Without scalingSince we can only show "잠시 기다려주세요" — fall through.
    const elapsedMin = status.scalingSince
      ? Math.max(0, Math.floor((Date.now() - Date.parse(status.scalingSince)) / 60_000))
      : null;
    const diff = Math.abs(target - status.activeCount);
    const totalMin = target > status.activeCount
      ? diff * 25 + 5  // scale-up
      : diff * 12 + 5; // scale-down
    const remainingMin = elapsedMin !== null
      ? Math.max(1, totalMin - elapsedMin)
      : null;
    return (
      <Box color="#3b82f6">
        🔵 클러스터 스케일링 중 ({status.activeCount} → {target})
        {remainingMin !== null && (
          <> · 약 <strong>{remainingMin}분</strong> 남음 ({elapsedMin}/{totalMin}분 경과)</>
        )}
        <div style={{ fontSize: 12, marginTop: 4, color: '#6b7280' }}>
          완료 후 자동으로 시작 버튼이 활성화됩니다. 페이지를 닫아도 진행은 계속됩니다.
        </div>
      </Box>
    );
  }

  // idle or degraded
  const diff = required - status.activeCount;

  if (diff > 0) {
    // need scale-up
    return (
      <Box color="#f59e0b">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          요구 사항: cs ≥ {required}
        </div>
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          현재 cluster: <strong>cs={status.activeCount}</strong>
          {status.uiState === 'degraded' ? ' (degraded)' : ''}
          <br />
          시작 전에 <strong>+{diff} HSM</strong> 프로비저닝 필요 (~{diff * 25 + 5}분)
        </div>
        {!viewerMode && (
          <ProvisionButton
            target={required}
            disabled={provisioning}
            onClick={async () => {
              setProvisioning(true);
              try {
                await api.provisionCluster(required);
                await refresh();
              } catch (err) {
                window.alert(`프로비저닝 실패: ${err}`);
              } finally {
                setProvisioning(false);
              }
            }}
          />
        )}
      </Box>
    );
  }

  if (diff < 0) {
    // over-provisioned: scenario uses fewer HSMs than current cluster
    return (
      <Box color="#10b981">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          ✓ 준비 완료 — 시나리오 시작 가능
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          현재 cs={status.activeCount}, 시나리오는 cs={required} 만 사용합니다.
          남는 HSM 은 측정에 영향이 없으며, 그대로 시작하면 됩니다.
          (cs={required} 까지 축소하고 싶다면 헤더의 cluster 칩에서 수동 조정)
        </div>
      </Box>
    );
  }

  // exactly matches
  return (
    <Box color="#10b981">
      ✓ 클러스터 준비 완료 (cs={status.activeCount}). 시나리오 시작 가능합니다.
    </Box>
  );
}

function Box({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        borderLeft: `3px solid ${color}`,
        background: `${color}11`,
        color: '#1f2937',
        padding: '10px 14px',
        borderRadius: 4,
        marginTop: 12,
        marginBottom: 12,
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

function ProvisionButton({ target, disabled, onClick }: {
  target: number; disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 13, padding: '6px 14px', borderRadius: 4,
        background: disabled ? '#9ca3af' : '#3b82f6',
        color: 'white', border: 'none',
        cursor: disabled ? 'wait' : 'pointer',
      }}
    >
      {disabled ? '시작 중…' : `cs=${target} 으로 프로비저닝하기`}
    </button>
  );
}
