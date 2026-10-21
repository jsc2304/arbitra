/**
 * @file webhook-misconfigured-block — rendering tests.
 *
 * Node-only per the frontend test convention (renderToStaticMarkup, no
 * jsdom). We assert the static markup contains the key pieces: repo name,
 * the CLI one-liner, the fallback UI steps, and the graceful-degrade path
 * when `github_full_name` is missing.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceEvent } from '@arbitra/shared';
import { WebhookMisconfiguredBlock } from '../webhook-misconfigured-block';

function makeEvent(evidence: Record<string, unknown> | undefined): WorkspaceEvent {
  return {
    event_id: 'workspaceEvent_1',
    type: 'webhook_misconfigured',
    actor_user_id: 'system:arbitra-webhook',
    timestamp: '2026-04-23T12:00:00.000Z',
    summary: 'GitHub webhook for foo/bar is missing pull_request',
    evidence,
  };
}

describe('WebhookMisconfiguredBlock', () => {
  it('renders the repo name from github_full_name', () => {
    const html = renderToStaticMarkup(
      <WebhookMisconfiguredBlock
        event={makeEvent({ github_full_name: 'acme/widgets', project_id: 'proj_1' })}
      />,
    );
    expect(html).toContain('acme/widgets');
  });

  it('renders the CLI one-liner with {HOOK_ID} placeholder when hook_id is absent', () => {
    const html = renderToStaticMarkup(
      <WebhookMisconfiguredBlock event={makeEvent({ github_full_name: 'acme/widgets' })} />,
    );
    // The canonical gh api invocation shape must appear verbatim so operators
    // can copy-paste it. The {HOOK_ID} placeholder tells them where to swap.
    expect(html).toContain('gh api -X PATCH /repos/acme/widgets/hooks/{HOOK_ID}');
    expect(html).toContain('events[]=pull_request');
    // Placeholder-replacement hint renders alongside so users know what to do.
    expect(html).toContain('gh api /repos/acme/widgets/hooks');
  });

  it('renders the UI-steps fallback that points at the GitHub hooks settings page', () => {
    const html = renderToStaticMarkup(
      <WebhookMisconfiguredBlock event={makeEvent({ github_full_name: 'acme/widgets' })} />,
    );
    expect(html).toContain('https://github.com/acme/widgets/settings/hooks');
    expect(html).toContain('Pull requests');
  });

  it('uses the concrete hook_id in the CLI command when provided', () => {
    const html = renderToStaticMarkup(
      <WebhookMisconfiguredBlock
        event={makeEvent({ github_full_name: 'acme/widgets', hook_id: 987654 })}
      />,
    );
    expect(html).toContain('/repos/acme/widgets/hooks/987654');
    expect(html).not.toContain('{HOOK_ID}');
  });

  it('degrades gracefully when github_full_name is missing', () => {
    const html = renderToStaticMarkup(
      <WebhookMisconfiguredBlock event={makeEvent({ repo_id: 'repo_42' })} />,
    );
    // Falls back to repo_id display and does NOT render a bogus CLI command
    // with "undefined" in the path.
    expect(html).toContain('repo_42');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('gh api -X PATCH');
  });

  it('links out to the project Repositories tab when project_id is present', () => {
    const html = renderToStaticMarkup(
      <WebhookMisconfiguredBlock
        event={makeEvent({ github_full_name: 'acme/widgets', project_id: 'proj_99' })}
      />,
    );
    expect(html).toContain('/projects/proj_99?tab=repositories');
  });

  it('falls back to event.timestamp when warned_at is absent', () => {
    const html = renderToStaticMarkup(
      <WebhookMisconfiguredBlock event={makeEvent({ github_full_name: 'acme/widgets' })} />,
    );
    expect(html).toContain('2026-04-23T12:00:00.000Z');
  });
});
