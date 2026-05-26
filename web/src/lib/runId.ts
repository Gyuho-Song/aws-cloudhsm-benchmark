'use client';

/**
 * Resolve the current run id from the browser URL. The build-time `params`
 * passed to the page component is locked to the placeholder route emitted
 * by `generateStaticParams`, so we re-read the URL at runtime to get the
 * real id the operator clicked through to.
 */
export function useRunIdFromUrl(): string {
  if (typeof window === 'undefined') return 'placeholder';
  const m = window.location.pathname.match(/^\/runs\/([^/]+)/);
  return m?.[1] ?? 'placeholder';
}
