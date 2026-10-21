import { describe, expect, it } from 'vitest';
import { actorDisplayName, CLIENT_DISPLAY_MAP, isDetectorActor } from '../actor-display';

describe('actorDisplayName', () => {
  it('maps known client_names to canonical display labels', () => {
    expect(
      actorDisplayName('usr_1', { client_name: 'arbitra-intelligence' }).label,
    ).toBe('Code Intelligence');
    expect(actorDisplayName('usr_1', { client_name: 'claude-code' }).label).toBe('Claude Code');
    expect(actorDisplayName('usr_1', { client_name: 'cursor' }).label).toBe('Cursor');
    expect(actorDisplayName('usr_1', { client_name: 'cline' }).label).toBe('Cline');
    expect(actorDisplayName('usr_1', { client_name: 'gemini-cli' }).label).toBe('Gemini CLI');
    expect(actorDisplayName('usr_1', { client_name: 'copilot' }).label).toBe('Copilot');
  });

  it('title-cases unknown client_names instead of hard-failing', () => {
    const res = actorDisplayName(undefined, { client_name: 'some-future-agent' });
    expect(res.label).toBe('Some Future Agent');
  });

  it('returns version as secondary label when client_version is present', () => {
    const res = actorDisplayName('usr_1', {
      client_name: 'arbitra-intelligence',
      client_version: '1.0.0',
    });
    expect(res.label).toBe('Code Intelligence');
    expect(res.secondary).toBe('arbitra-intelligence 1.0.0');
  });

  it('collapses system actor variants to a single "Arbitra" label', () => {
    // The raw `system` id, `system:pipeline`, `system:intelligence` all map
    // to the same user-facing label. This is the central regression that
    // motivated the helper — the feed previously rendered "Arbitra",
    // "system", and the client_name literal for conceptually-equivalent rows.
    expect(actorDisplayName('system', undefined).label).toBe('Arbitra');
    expect(actorDisplayName('system:pipeline', undefined).label).toBe('Arbitra');
    expect(actorDisplayName('system:intelligence', undefined).label).toBe('Arbitra');
  });

  it('client_name takes precedence over system actor id', () => {
    // When a system pipeline action carries actor_metadata (e.g. the
    // intelligence detector writes evidence as `system:intelligence` with
    // `client_name: arbitra-intelligence`), we want the client label so the
    // activity card differentiates it from generic "Arbitra" rows.
    const res = actorDisplayName('system:intelligence', {
      client_name: 'arbitra-intelligence',
    });
    expect(res.label).toBe('Code Intelligence');
  });

  it('falls back to resolved human name for real users', () => {
    expect(actorDisplayName('usr_abcdefghijklmnop1234', undefined, 'Alice').label).toBe('Alice');
  });

  it('falls back to "User" label for unresolved Firebase UIDs', () => {
    expect(actorDisplayName('AbCdEfGhIjKlMnOpQrStUvWxYz', undefined).label).toBe('User');
  });

  it('returns em-dash when neither user nor metadata is present', () => {
    expect(actorDisplayName(undefined, undefined).label).toBe('—');
  });

  it('exports the CLIENT_DISPLAY_MAP for external consumers', () => {
    expect(CLIENT_DISPLAY_MAP['arbitra-intelligence']).toBe('Code Intelligence');
    expect(CLIENT_DISPLAY_MAP['claude-code']).toBe('Claude Code');
  });

  // Synthetic sentinels emitted by the leaderboard aggregator. The UI must
  // render friendly labels for these — previously only `human` was special-
  // cased in the leaderboard itself, producing misleading "Humans" rows for
  // CI / webhook writes.
  it('maps leaderboard synthetic sentinels to friendly labels', () => {
    expect(actorDisplayName(undefined, { client_name: 'automated' }).label).toBe(
      'CI / Automated',
    );
    expect(actorDisplayName(undefined, { client_name: 'webhook' }).label).toBe('Webhook');
    expect(actorDisplayName(undefined, { client_name: 'system' }).label).toBe('Arbitra');
    expect(actorDisplayName(undefined, { client_name: 'human' }).label).toBe('Humans');
  });
});

describe('isDetectorActor (pre-envelope fallback only)', () => {
  // This heuristic is retained ONLY as a fallback for pre-envelope rows; the
  // activity row prefers the authoritative `opened_by` envelope field. The
  // exact-match semantics must stay tight so plain `system` / other `system:*`
  // actors don't accidentally render as detector-flagged cases.
  it('matches the detector actor id exactly', () => {
    expect(isDetectorActor('system:arbitra-intelligence')).toBe(true);
  });

  it('rejects plain system and other system: actors', () => {
    expect(isDetectorActor('system')).toBe(false);
    expect(isDetectorActor('system:webhook')).toBe(false);
    expect(isDetectorActor('system:scheduler')).toBe(false);
  });

  it('rejects human / unknown / empty ids', () => {
    expect(isDetectorActor('user_alex')).toBe(false);
    expect(isDetectorActor(undefined)).toBe(false);
    expect(isDetectorActor('')).toBe(false);
  });
});
