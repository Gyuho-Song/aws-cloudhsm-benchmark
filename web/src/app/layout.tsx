import type { ReactNode } from 'react';
import './globals.css';
import HsmStatusBadge from '@/components/HsmStatusBadge';

export const metadata = {
  title: 'CloudHSM CloudHSM BMT — Operator Console',
  description: 'Aurora — luminous control surface for the CloudHSM CloudHSM benchmark fleet.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
          <defs>
            <linearGradient id="auroraStroke" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#5dffc8" />
              <stop offset="50%" stopColor="#5cb8ff" />
              <stop offset="100%" stopColor="#a07dff" />
            </linearGradient>
          </defs>
        </svg>
        <div className="grain" aria-hidden />
        <div className="shell">
          <header className="topbar rise">
            <a className="wordmark" href="/">
              <span className="glyph" aria-hidden>
                <svg viewBox="0 0 24 24">
                  <path d="M4 14c4-7 12-7 16 0" />
                  <path d="M4 18c5-4 11-4 16 0" />
                  <circle cx="12" cy="9" r="1.4" fill="url(#auroraStroke)" stroke="none" />
                </svg>
              </span>
              <span className="lockup">
                <span className="name">CloudHSM Aurora</span>
                <span className="sub">CloudHSM · BMT Operator Console</span>
              </span>
            </a>
            <div className="session">
              <HsmStatusBadge />
              <span className="pill live">ap-northeast-2</span>
              <span className="pill">FIPS 140-3 L3</span>
            </div>
          </header>
          <main className="canvas">{children}</main>
          <footer className="footline">
            <span>CloudHSM × <PARTNER> × AWS · Phase 1 BMT</span>
            <span>Cert #4703 · hsm2m.medium · 6 HSM cluster</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
