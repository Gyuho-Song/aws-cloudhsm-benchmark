'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ClusterStatus } from '@/lib/apiClient';
import { getAccessToken } from '@/lib/auth';
import { isViewer } from '@/lib/groups';

/**
 * Header badge displaying current HSM cluster status (HOS-Step5).
 *
 * Polls /api/cluster/status at 30s when idle, 10s when scaling. Shows one
 * of four states:
 *   🟢 idle      — ACTIVE == desired, ready for measurement
 *   🟡 degraded  — ACTIVE != desired, no scale op in progress
 *   🔵 scaling   — DeleteHsm/CreateHsm in progress
 *   🔴 unknown   — API unavailable
 *
 * Includes a "Restore to N" 1-click button when degraded (operator-only).
 */
export default function HsmStatusBadge() {
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [viewerMode, setViewerMode] = useState(true);
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setViewerMode(isViewer());
    setAuthed(!!getAccessToken());
  }, []);

  const refresh = useCallback(async () => {
    // Pre-login pages (Hosted UI redirect, /callback) don't have a token —
    // skip the API call entirely so we don't surface a 401 as a red error
    // chip in the header.
    if (!getAccessToken()) {
      setAuthed(false);
      return;
    }
    try {
      const s = await api.getClusterStatus();
      setStatus(s);
      setError(null);
      setAuthed(true);
    } catch (err) {
      // 401 → apiClient.request() initiates Hosted UI redirect; the chip
      // text is irrelevant during that redirect, so suppress the red error.
      // 2026-05-26: also match "인증" / "권한" — humanizeError + custom
      // authorizer use these words, and they're equally indicative of an
      // auth issue that's already being handled (or about to be) by the
      // redirect path. Without these matches, an auth race surfaced as
      // "🔴 HSM API 오류" on a healthy cluster.
      const msg = String(err);
      const isAuthIssue = ['재로그인', '만료', '인증', '권한'].some((w) => msg.includes(w));
      if (isAuthIssue) {
        setAuthed(false);
        setError(null);
      } else {
        setError(msg);
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = status?.uiState === 'scaling' ? 10_000 : 30_000;
    const id = window.setInterval(refresh, interval);
    return () => window.clearInterval(id);
  }, [refresh, status?.uiState]);

  // 2026-05-26: handleRestore MUST be declared before any early return
  // (React Hooks rule). The previous code had this useCallback below the
  // `if (authed === false) return null` guard, which meant a render where
  // authed transitioned false→true would call useCallback for the FIRST
  // time on a render that previously skipped it → "Rendered more hooks
  // than during the previous render" → client-side exception. Same bug
  // class as the PreFlightPanel hook fix earlier today.
  const handleRestore = useCallback(async () => {
    if (!status) return;
    if (!window.confirm(
      `클러스터를 cs=${status.desiredCount} 로 복원합니다. ` +
      `현재 ${status.activeCount}대 → 목표 ${status.desiredCount}대. ` +
      `약 ${(status.desiredCount - status.activeCount) * 25 + 5}분 소요. 진행하시겠습니까?`,
    )) return;
    setProvisioning(true);
    try {
      await api.provisionCluster(status.desiredCount);
      await refresh();
    } catch (err) {
      window.alert(`프로비저닝 실패: ${err}`);
    } finally {
      setProvisioning(false);
    }
  }, [status, refresh]);

  // Don't render anything before login — the badge has no useful data and
  // would just confuse visitors on the Hosted UI flow.
  if (authed === false) return null;

  if (error) {
    return <span style={badgeStyle('#ef4444')}>🔴 HSM API 오류</span>;
  }
  if (!status) {
    return <span style={badgeStyle('#9ca3af')}>⏳ HSM 상태 확인 중…</span>;
  }

  const { uiState, activeCount, desiredCount } = status;

  if (uiState === 'unknown') {
    return <span style={badgeStyle('#ef4444')}>🔴 HSM unreachable</span>;
  }

  if (uiState === 'scaling') {
    // 2026-05-26: prefer scalingTarget (the actual in-flight target) over
    // desiredCount (the post-reset baseline, default 6). Without this, a
    // 6→3 hard-scale would render as '5 → 6' midway through the deletes.
    const target = status.scalingTarget ?? desiredCount;
    return (
      <span style={badgeStyle('#3b82f6')}>
        🔵 HSM scaling {activeCount} → {target}
      </span>
    );
  }

  // Phase F (cluster-state-rca-plan): scaling lock held > 90 min → stale.
  // Show admin a force-unlock button (viewer just sees the chip).
  if (uiState === 'stale') {
    const ageMin = status.staleAgeMinutes ?? 0;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={badgeStyle('#dc2626')}>
          ⚠ HSM scaling lock stale ({ageMin}분)
        </span>
        {!viewerMode && (
          <button
            type="button"
            onClick={async () => {
              if (!window.confirm(
                `클러스터 scaling 락을 강제로 해제합니다 (현재 ${ageMin}분 경과).\n` +
                `실제 scale 작업이 진행 중이지 않은지 먼저 확인하세요.\n` +
                `진행하시겠습니까?`,
              )) return;
              setProvisioning(true);
              try {
                await api.forceUnlockCluster();
                await refresh();
              } catch (err) {
                window.alert(`강제 해제 실패: ${err}`);
              } finally {
                setProvisioning(false);
              }
            }}
            disabled={provisioning}
            style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 4,
              background: provisioning ? '#9ca3af' : '#dc2626',
              color: 'white', border: 'none',
              cursor: provisioning ? 'wait' : 'pointer',
            }}
            title="cluster-state SSM 을 강제로 idle 로 set"
          >
            {provisioning ? '해제 중…' : '강제 해제'}
          </button>
        )}
      </span>
    );
  }

  if (uiState === 'idle') {
    return (
      <span style={badgeStyle('#10b981')}>
        🟢 HSM {activeCount}/{desiredCount} ready
      </span>
    );
  }

  // degraded
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={badgeStyle('#f59e0b')}>
        🟡 HSM {activeCount}/{desiredCount} degraded
      </span>
      {!viewerMode && (
        <button
          type="button"
          onClick={handleRestore}
          disabled={provisioning}
          style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 4,
            background: provisioning ? '#9ca3af' : '#3b82f6',
            color: 'white', border: 'none',
            cursor: provisioning ? 'wait' : 'pointer',
          }}
          title={`cs=${desiredCount}로 복원 (~${(desiredCount - activeCount) * 25 + 5}분)`}
        >
          {provisioning ? '시작 중…' : `cs=${desiredCount}로 복원`}
        </button>
      )}
    </span>
  );
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 999,
    background: `${color}22`,
    border: `1px solid ${color}`,
    color: color,
    fontWeight: 500,
  };
}
