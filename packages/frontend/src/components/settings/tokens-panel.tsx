'use client';

/**
 * `<TokensPanel>` — "Connections" tab in Settings.
 *
 * Spec: `docs/specs/device-flow-and-per-tool-tokens.md` §F.2.
 *
 * Layout:
 *   - "Legacy tokens" section at the top (tokens with neither `client_name`
 *     nor `created_via` set) — each row has a "Replace" CTA explaining how to
 *     re-run `arbitra-mcp login`.
 *   - One section per `(device_id, device_label)` group below — header
 *     includes a "Revoke all tokens on this device" bulk action.
 *   - Inside each device group: rows grouped by `client_name` with columns
 *     Tool / Created via / Last seen / Created at.
 *   - "Advanced" disclosure at the bottom — single "Create CI service token…"
 *     button that reveals the original manual-create form (PR 2 keeps the
 *     primary "Generate Token" button removed per the spec).
 */
import { useState, useMemo } from 'react';
import useSWR from 'swr';
import type { PersonalAccessToken } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { useEscapeKey } from '../../hooks/use-escape-key';
import { RelativeTime } from '../shared/relative-time';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';

/** Bucket key used by `groupTokens`. */
type DeviceGroupKey = string;

/**
 * Split tokens into the legacy bucket (no per-tool metadata) and per-device
 * groups. Each device group keeps the list of `(client_name, [tokens])` so the
 * UI can render two-level grouping (device → tool) without re-iterating.
 *
 * Pure, exported for tests.
 */
export function groupTokens(tokens: PersonalAccessToken[]): {
  legacy: PersonalAccessToken[];
  devices: Array<{
    key: DeviceGroupKey;
    device_id?: string;
    device_label: string;
    tools: Array<{ client_name: string; tokens: PersonalAccessToken[] }>;
  }>;
} {
  const legacy: PersonalAccessToken[] = [];
  const byDevice = new Map<DeviceGroupKey, { device_id?: string; device_label: string; toolBuckets: Map<string, PersonalAccessToken[]> }>();
  for (const t of tokens) {
    // A token is "legacy" when it has neither client_name nor created_via —
    // matches the spec wording in §F.2.
    if (!t.client_name && !t.created_via) {
      legacy.push(t);
      continue;
    }
    const deviceKey = `${t.device_id ?? '__no_device__'}::${t.device_label ?? 'Unknown device'}`;
    let group = byDevice.get(deviceKey);
    if (!group) {
      group = {
        device_id: t.device_id,
        device_label: t.device_label ?? 'Unknown device',
        toolBuckets: new Map(),
      };
      byDevice.set(deviceKey, group);
    }
    const toolKey = t.client_name ?? 'unknown';
    const bucket = group.toolBuckets.get(toolKey) ?? [];
    bucket.push(t);
    group.toolBuckets.set(toolKey, bucket);
  }
  const devices = Array.from(byDevice.entries()).map(([key, g]) => ({
    key,
    device_id: g.device_id,
    device_label: g.device_label,
    tools: Array.from(g.toolBuckets.entries()).map(([client_name, tokens]) => ({ client_name, tokens })),
  }));
  // Sort: devices with a real device_id first, then alphabetic by label.
  devices.sort((a, b) => {
    if (!!a.device_id !== !!b.device_id) return a.device_id ? -1 : 1;
    return a.device_label.localeCompare(b.device_label);
  });
  return { legacy, devices };
}

/**
 * Decide whether to colour-cue a "last seen" timestamp red (i.e. >60 days
 * stale). Returns the Tailwind text-colour class to apply, or `''` when no
 * cue is needed. Pure helper exported for tests.
 */
export function lastSeenColourClass(lastSeenIso: string | undefined, nowMs: number): string {
  if (!lastSeenIso) return 'text-gray-400 dark:text-gray-500';
  const age = nowMs - Date.parse(lastSeenIso);
  if (!Number.isFinite(age) || age < 0) return 'text-gray-400 dark:text-gray-500';
  const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
  if (age > sixtyDaysMs) return 'text-amber-600 dark:text-amber-400';
  return 'text-gray-500 dark:text-gray-400';
}

/** Friendly badge label for a token's origin. */
export function createdViaBadgeLabel(token: PersonalAccessToken): string {
  switch (token.created_via) {
    case 'unified_connect': return 'Connect flow';
    case 'ci_service': return 'CI';
    case 'manual': return 'Manual';
    default: return 'Manual';
  }
}

export function TokensPanel() {
  const { data, mutate } = useSWR('tokens', () => api.tokens.list());
  const { addToast } = useToast();
  // Stable reference to the underlying array — the SWR `data` identity already
  // changes only on real revalidations, so memoizing on `data?.tokens` directly
  // dedups grouping work without the lint warning that the `??` ternary fires.
  const grouped = useMemo(() => groupTokens(data?.tokens ?? []), [data?.tokens]);

  // ── CI-service-token (Advanced) form state ──────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [ciName, setCiName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newRawToken, setNewRawToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Revoke flows ─────────────────────────────────────────────────────────
  const [revokeTarget, setRevokeTarget] = useState<{ token_id: string; name: string } | null>(null);
  const [revokeDeviceTarget, setRevokeDeviceTarget] = useState<{ device_id: string; device_label: string; count: number } | null>(null);
  const [revoking, setRevoking] = useState(false);

  // ── Legacy replace dialog ────────────────────────────────────────────────
  const [replaceTarget, setReplaceTarget] = useState<PersonalAccessToken | null>(null);

  useEscapeKey(() => {
    setRevokeTarget(null);
    setRevokeDeviceTarget(null);
    setReplaceTarget(null);
  }, !!revokeTarget || !!revokeDeviceTarget || !!replaceTarget);

  async function handleCreateCi(e: React.FormEvent) {
    e.preventDefault();
    if (!ciName.trim()) return;
    setCreating(true);
    try {
      const result = await api.tokens.create(ciName.trim(), {
        client_name: 'ci',
        created_via: 'ci_service',
      });
      setNewRawToken(result.raw_token);
      addToast('success', 'CI service token created');
      setCiName('');
      setShowCreate(false);
      mutate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to create token');
    } finally {
      setCreating(false);
    }
  }

  async function handleSingleDelete(tokenId: string) {
    await api.tokens.delete(tokenId);
    addToast('success', 'Token revoked');
    mutate();
  }

  async function handleDeviceDelete(deviceId: string) {
    const result = await api.tokens.deleteByDevice(deviceId);
    addToast('success', `Revoked ${result.deleted_count} tokens on this device`);
    mutate();
  }

  function handleCopy() {
    if (newRawToken) {
      navigator.clipboard.writeText(newRawToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="max-w-3xl">
      <SectionHeader
        eyebrow
        title="Connections"
        description="One token per tool × device. New tokens come from the unified Connect flow — no copy-paste."
        className="mb-4"
      />

      {/* Just-created token reveal — only for the CI service path now. */}
      {newRawToken && (
        <div className="mb-4 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/50 p-4">
          <div className="flex items-start gap-2">
            <svg className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-green-800 dark:text-green-400">
                Token created — copy it now, it won&apos;t be shown again.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded bg-green-100 dark:bg-green-900/50 px-3 py-1.5 text-xs font-mono text-green-800 dark:text-green-300 truncate select-all">
                  {newRawToken}
                </code>
                <button
                  onClick={handleCopy}
                  className="flex-shrink-0 rounded bg-green-100 dark:bg-green-900/50 px-3 py-1.5 text-xs font-medium text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-800 transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <button
              onClick={() => setNewRawToken(null)}
              className="text-green-400 hover:text-green-600"
              aria-label="Dismiss token reveal"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* Legacy tokens — call-to-action banner per §F.2. */}
      {grouped.legacy.length > 0 && (
        <section className="mb-6" data-testid="legacy-section">
          <h4 className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide mb-2">
            Legacy tokens
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            These tokens were created before the per-tool model. Replace each one by re-running <code className="font-mono">arbitra-mcp login</code> from the relevant tool.
          </p>
          <ul className="bg-surface-raised border border-amber-200 dark:border-amber-900 rounded-lg divide-y divide-amber-100 dark:divide-amber-900/50">
            {grouped.legacy.map((token) => (
              <li key={token.token_id} className="px-4 py-3 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{token.name}</p>
                  <div className="flex items-center gap-3 mt-0.5">
                    <code className="text-xs font-mono text-gray-500 dark:text-gray-400">{token.token_prefix}</code>
                    <RelativeTime timestamp={token.created_at} prefix="Created" className="text-[10px] text-gray-400 dark:text-gray-500" />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setReplaceTarget(token)}
                    className="rounded-md border border-amber-300 dark:border-amber-700 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950"
                    data-testid="replace-cta"
                  >
                    Replace
                  </button>
                  <button
                    onClick={() => setRevokeTarget({ token_id: token.token_id, name: token.name })}
                    className="text-gray-300 dark:text-gray-600 hover:text-red-500"
                    title="Revoke token"
                    aria-label={`Revoke ${token.name}`}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9M18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79" /></svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Device-grouped sections */}
      {grouped.devices.length === 0 && grouped.legacy.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">
          {grouped.devices.map((device) => (
            <DeviceSection
              key={device.key}
              device={device}
              onRequestRevokeToken={(tokenId, name) => setRevokeTarget({ token_id: tokenId, name })}
              onRequestRevokeDevice={() => {
                if (!device.device_id) return;
                const count = device.tools.reduce((sum, t) => sum + t.tokens.length, 0);
                setRevokeDeviceTarget({ device_id: device.device_id, device_label: device.device_label, count });
              }}
            />
          ))}
        </div>
      )}

      {/* Advanced disclosure */}
      <section className="mt-8 border-t border-gray-200 dark:border-border-subtle pt-6">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1"
          aria-expanded={showAdvanced}
          data-testid="advanced-toggle"
        >
          <svg className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
          </svg>
          Advanced
        </button>
        {showAdvanced && (
          <div className="mt-3">
            {!showCreate ? (
              <button
                onClick={() => setShowCreate(true)}
                className="rounded-md border border-gray-300 dark:border-border-default px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base"
                data-testid="create-ci-button"
              >
                Create CI service token…
              </button>
            ) : (
              <form onSubmit={handleCreateCi} className="rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised p-4">
                <label htmlFor="ci-token-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  CI token name
                </label>
                <div className="flex gap-2">
                  <input
                    id="ci-token-name"
                    type="text"
                    value={ciName}
                    onChange={(e) => setCiName(e.target.value)}
                    placeholder="e.g. GitHub Actions main"
                    className="flex-1 rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setCiName(''); }}
                    className="text-xs text-gray-500 hover:text-gray-700 px-2"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !ciName.trim()}
                    className="rounded-md bg-accent-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300"
                  >
                    {creating ? 'Creating…' : 'Create'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Use this only for CI / unattended environments. For your local IDE, run <code className="font-mono">arbitra-mcp login</code> instead.
                </p>
              </form>
            )}
          </div>
        )}
      </section>

      {/* Single-token revoke dialog */}
      {revokeTarget && (
        <ConfirmDialog
          title="Revoke token"
          message={<>Revoke <strong>{revokeTarget.name}</strong>? Any agent using this token will lose access immediately.</>}
          confirmLabel="Revoke"
          destructive
          loading={revoking}
          onCancel={() => setRevokeTarget(null)}
          onConfirm={async () => {
            setRevoking(true);
            try { await handleSingleDelete(revokeTarget.token_id); }
            finally { setRevoking(false); setRevokeTarget(null); }
          }}
        />
      )}

      {/* Bulk device revoke dialog */}
      {revokeDeviceTarget && (
        <ConfirmDialog
          title="Revoke all tokens on this device"
          message={<>
            Revoke <strong>{revokeDeviceTarget.count}</strong> {revokeDeviceTarget.count === 1 ? 'token' : 'tokens'} on{' '}
            <strong>{revokeDeviceTarget.device_label}</strong>? Every tool on this device will need to reconnect.
          </>}
          confirmLabel="Revoke all"
          destructive
          loading={revoking}
          onCancel={() => setRevokeDeviceTarget(null)}
          onConfirm={async () => {
            setRevoking(true);
            try { await handleDeviceDelete(revokeDeviceTarget.device_id); }
            finally { setRevoking(false); setRevokeDeviceTarget(null); }
          }}
        />
      )}

      {/* Legacy replace dialog */}
      {replaceTarget && (
        <ConfirmDialog
          title="Replace this legacy token"
          message={<>
            <p>Run this command in your IDE&apos;s repository:</p>
            <pre className="mt-2 rounded bg-surface-base border border-gray-200 dark:border-border-subtle px-3 py-2 text-xs font-mono text-gray-800 dark:text-gray-200">arbitra-mcp login</pre>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              The new token lives in your OS keychain — no copy-paste. Then revoke <strong>{replaceTarget.name}</strong> from this panel.
            </p>
          </>}
          confirmLabel="Got it"
          onCancel={() => setReplaceTarget(null)}
          onConfirm={() => setReplaceTarget(null)}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <Card padding="none" className="px-6 py-10 text-center">
      <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
      </svg>
      <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">No connections yet</p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Install the MCP server in your IDE — the first tool call will print a link to connect this account.
      </p>
    </Card>
  );
}

interface DeviceSectionProps {
  device: ReturnType<typeof groupTokens>['devices'][number];
  onRequestRevokeToken: (tokenId: string, name: string) => void;
  onRequestRevokeDevice: () => void;
}

function DeviceSection({ device, onRequestRevokeToken, onRequestRevokeDevice }: DeviceSectionProps) {
  const totalTokens = device.tools.reduce((sum, t) => sum + t.tokens.length, 0);
  return (
    <Card as="section" padding="none" data-testid="device-section">
      <header className="px-4 py-3 flex items-center justify-between border-b border-gray-100 dark:border-gray-800">
        <div>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{device.device_label}</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {totalTokens} {totalTokens === 1 ? 'token' : 'tokens'} across {device.tools.length} {device.tools.length === 1 ? 'tool' : 'tools'}
          </p>
        </div>
        {device.device_id && (
          <button
            onClick={onRequestRevokeDevice}
            className="text-xs text-red-600 dark:text-red-400 hover:underline"
            data-testid="revoke-device"
          >
            Revoke all on this device
          </button>
        )}
      </header>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {device.tools.map((tool) => (
          tool.tokens.map((token) => (
            <TokenRow key={token.token_id} token={token} onRevoke={() => onRequestRevokeToken(token.token_id, token.name)} />
          ))
        ))}
      </ul>
    </Card>
  );
}

function TokenRow({ token, onRevoke }: { token: PersonalAccessToken; onRevoke: () => void }) {
  const colour = lastSeenColourClass(token.last_used_at, Date.now());
  const toolDisplay = token.client_name
    ? `${token.client_name}${token.client_version ? ` ${token.client_version}` : ''}`
    : token.name;
  return (
    <li className="px-4 py-3 flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{toolDisplay}</p>
          <Badge>{createdViaBadgeLabel(token)}</Badge>
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-[11px]">
          <code className="font-mono text-gray-500 dark:text-gray-400">{token.token_prefix}</code>
          <RelativeTime timestamp={token.created_at} prefix="Created" className="text-gray-400 dark:text-gray-500" />
          {token.last_used_at ? (
            <RelativeTime timestamp={token.last_used_at} prefix="Last seen" className={colour} />
          ) : (
            <span className="text-gray-400 dark:text-gray-500">Never used</span>
          )}
        </div>
      </div>
      <button
        onClick={onRevoke}
        className="text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-colors"
        title="Revoke token"
        aria-label={`Revoke ${toolDisplay}`}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9M18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79" /></svg>
      </button>
    </li>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
      {children}
    </span>
  );
}

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Small inline confirm dialog. We avoid pulling in `<ConfirmDialog>` from
 * `components/shared/confirm-dialog.tsx` because it lacks the destructive
 * styling + JSX-message support this panel needs; the styling matches the
 * legacy revocation modal in the prior version of this file.
 */
function ConfirmDialog({ title, message, confirmLabel, destructive, loading, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
    >
      <div className="mx-4 w-full max-w-sm rounded-lg bg-surface-raised shadow-xl">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <div className="mt-3 text-sm text-gray-600 dark:text-gray-400">{message}</div>
        </div>
        <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-accent-700 hover:bg-accent-800'}`}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
