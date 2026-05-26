# `web/` — 운영자 콘솔 (Next.js 14)

CloudHSM 벤치마크 운영자가 시나리오를 실행·모니터링·리포트 조회하는 웹 콘솔. Cognito Hosted UI(PKCE)로 로그인하고 모든 API 호출은 Bearer access token을 첨부합니다.

## 라우트 구조

```
/                          홈 — 시나리오 / 진행 / 결과 카드 + 헤더 chip
/runs/new                  새 Run 생성 — 시나리오 카드 4개 + Custom matrix + Loader 검증
/runs/[id]/live            진행 중 cell 단위 진척도, ETA, abort 버튼
/runs/[id]/results         완료된 unit 표 + per-cell ops/p99
/runs/[id]/dashboard       Grafana 임베드 (live-run 대시보드)
/runs/[id]/report          PDF/HTML 리포트 뷰어 (S3 presigned URL)
/monitor                   클러스터 헬스 + 최근 에러 모니터
/callback                  Cognito Hosted UI redirect (PKCE 토큰 교환)
/logout                    세션 종료 + Hosted UI logout 리디렉션
```

`/api/*` 호출은 모두 `web/src/lib/apiClient.ts`의 `request()`를 거치며, 401 → 자동 Hosted UI 재로그인, 4xx 구조화 응답은 `humanizeError()`로 한국어 메시지 변환.

## 컴포넌트 (`src/components/`)

- **`HsmStatusBadge`** — 헤더 우상단 chip. 30s/10s 폴링으로 4 상태 표시: `🟢 idle (cs=N/M ready)` / `🟡 degraded (cs=N/M)` / `🔵 scaling (N → M, 약 X분 남음)` / `⚠ stale (>90분)`. degraded일 때 "복원" 버튼, stale일 때 "강제 해제" 버튼 (admin 전용).
- **`PreFlightPanel`** — `/runs/new`에서 시나리오 미리보기 시 cluster 상태와 시나리오의 `requiredStartHsmCount` 비교. 부족하면 "+N HSM 프로비저닝" 버튼, scaling 중이면 ETA 안내, ready면 ✓ 표시.
- **`MatrixSelector`** — Custom 시나리오용 axis 선택기. algorithm/mode/payload chip toggle, cluster size는 radio (단일 선택). Family는 PER_CALL_RAW 고정.

## 유틸 (`src/lib/`)

- **`apiClient.ts`** — `fetch` wrapper. Bearer 토큰 자동 첨부, 401 시 refresh-and-retry → 실패 시 Hosted UI 리디렉션. `humanizeError()`가 backend 에러 코드(`cluster_not_ready`, `cluster_scaling_in_progress`, `another run is already in progress` 등)를 한국어 메시지로 매핑.
- **`auth.ts`** — Cognito PKCE 흐름 (state/code-verifier 생성, 토큰 교환, refresh). Access token / ID token / Refresh token을 `sessionStorage`에 보관.
- **`groups.ts`** — JWT의 `cognito:groups` 클레임을 디코드해서 `admin` / `viewer` 판별. UI는 viewer일 때 모든 mutating 버튼 disable.
- **`scenarios.ts`** — 4개 시나리오 정의 (Smoke / PER_CALL Full / Partial / Custom). 각 시나리오에 `requiredStartHsmCount`, `procsByCluster` (HSM-adaptive procs sweet-spot: cs=6→12, 5→12, 4→10, 3→8, 2→6), description 등 메타데이터.
- **`matrix.ts`** — `MatrixSubset` 타입 정의 + `countUnits()` (cell 갯수 계산) + `matrixFromUnits()` (clone/retry 흐름에서 unit 목록을 다시 matrix로 reconstruct).
- **`queue.ts`** — `localStorage` 기반 run queue (큐에 추가 → 이전 run 종료 후 자동 시작). 사이드패널에서 사용.
- **`runId.ts`** — `rid-YYYYMMDDHHMMSS` 포맷 헬퍼.

## Cognito 인증 흐름 (PKCE)

```
1. /runs/new 진입 → access token 없음 → login() 호출
2. PKCE: code-verifier 생성 → SHA-256 → code-challenge → sessionStorage에 verifier 저장
3. Hosted UI(/oauth2/authorize)로 리디렉션 (response_type=code, code_challenge, state)
4. 사용자 로그인
5. /callback으로 redirect — code + state 수신
6. /oauth2/token POST (code + verifier) → id/access/refresh 토큰 수신
7. sessionStorage에 저장 → 원래 가려던 페이지로 복귀
```

이후 모든 API 호출은 `Authorization: Bearer <access_token>` 첨부. Custom REQUEST authorizer가 `custom:sessionId` 클레임으로 single-admin 락을 검증합니다.

## 빌드 & 로컬 실행

```bash
cd web
npm install

# 로컬 개발 — 환경 변수만 .env.local에 설정
cat > .env.local <<EOF
NEXT_PUBLIC_API_BASE=https://<api-id>.execute-api.ap-northeast-2.amazonaws.com/prod/
NEXT_PUBLIC_COGNITO_DOMAIN=<your-cognito-domain>.auth.ap-northeast-2.amazoncognito.com
NEXT_PUBLIC_COGNITO_CLIENT_ID=<your-client-id>
NEXT_PUBLIC_AMG_WORKSPACE_URL=<workspace-id>.grafana-workspace.ap-northeast-2.amazonaws.com
EOF

npm run dev                # localhost:3000

# 프로덕션 빌드 — CDK가 web/out/ 을 S3에 업로드
npm run build              # next build + next export → web/out/
```

`output: 'export'` 모드 (`next.config.mjs`)라서 정적 사이트 (CloudFront + S3). 서버 사이드 코드는 없음.

## 테스트

```bash
npm test                   # Jest + Testing Library
```

테스트 파일:
- `src/lib/apiClient.test.ts` — humanizeError 매핑, 401 handling
- `src/lib/groups.test.ts` — JWT 디코드 + admin/viewer 판별
- `src/components/MatrixSelector.test.tsx` — chip toggle / radio 동작

## 스타일 가이드

- App Router + Server Components (단, `'use client'` 마커가 붙은 파일은 클라이언트 사이드)
- Inline style + CSS variable 기반 — `web/src/app/globals.css`에 Aurora 테마 (`--aurora-teal`, `--aurora-violet` 등) 정의
- 외부 UI 라이브러리 없음 (Tailwind 미사용) — 의도적으로 lean dependency 유지

## 배포

CDK `WebStack`의 `FrontendConstruct`가 `web/out/`을 source로 잡아 S3에 업로드 + CloudFront invalidation까지 자동 처리. 따라서:

```bash
cd web && npm run build
cd ../iac && npx cdk deploy WebStack --require-approval never
```

순서를 지키지 않고 `web/out/`이 비어 있으면 CDK 합성이 실패합니다.
