// Static export with dynamic [id] route: emit a single placeholder route at
// build time so the [id] folder builds at all. Real run IDs are resolved at
// runtime client-side from the URL via `useParams()` / the page's `params`
// prop, since CloudFront has a 404 -> /index.html fallback for SPA routing.
export function generateStaticParams() {
  return [{ id: 'placeholder' }];
}

export const dynamicParams = false;

export default function RunIdLayout({ children }: { children: React.ReactNode }) {
  return children;
}
