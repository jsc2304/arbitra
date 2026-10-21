/**
 * `/connect` — unified device-flow confirmation page.
 *
 * Spec: `docs/specs/device-flow-and-per-tool-tokens.md` §F.1, §J.2.
 *
 * Server component — reads `searchParams.code` and seeds the client component.
 * The client component talks to `/api/auth/connect/{lookup,approve,cancel}`
 * (PR 1 endpoints plus the PR 2 lookup helper). The page-level `<AuthGate>`
 * in `app/layout.tsx` handles the signed-out branch; popup-based Google
 * sign-in keeps the `?code=…` URL intact, so the post-sign-in re-render lands
 * directly in the confirm view.
 */
import { ConnectFlow } from '../../components/connect/connect-flow';

export const dynamic = 'force-dynamic';

interface ConnectPageProps {
  searchParams: Promise<{ code?: string | string[] }>;
}

export default async function ConnectPage(props: ConnectPageProps) {
  const searchParams = await props.searchParams;
  const rawCode = searchParams.code;
  // Defensive — Next can pass arrays for repeated query params. We accept the
  // first only; the client normalizes alphabet + hyphen via `<CodeInput>`.
  const code = Array.isArray(rawCode) ? rawCode[0] : rawCode;
  const initialCode = typeof code === 'string' && code.trim() ? code.trim() : null;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-surface-base">
      <ConnectFlow initialCode={initialCode} />
    </div>
  );
}
