import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateId, deriveFindingId } from './ids.js';

/**
 * `tok_${Date.now()}` / `proj_${Date.now()}` /
 * `repo_${Date.now()}` were replaced with `generateId()` because two
 * same-millisecond POSTs silently overwrote each other via Firestore
 * `.set()`. These tests lock down the resulting id shape — prefix plus a
 * non-timestamp, collision-resistant suffix — for every prefixed entity
 * type, with `token` (newly added for the tokens route) called out
 * explicitly.
 */
describe('generateId', () => {
  const prefixedCases: Array<[Parameters<typeof generateId>[0], string]> = [
    ['run', 'run_'],
    ['finding', 'fnd_'],
    ['evidence', 'ev_'],
    ['rule', 'rule_'],
    ['ruleSet', 'rs_'],
    ['ruleResult', 'rr_'],
    ['knowledgeAsset', 'ka_'],
    ['decision', 'dec_'],
    ['comment', 'cmt_'],
    ['artifact', 'art_'],
    ['project', 'proj_'],
    ['repository', 'repo_'],
    ['user', 'usr_'],
    ['token', 'tok_'],
    ['event', 'evt_'],
    ['notification', 'notif_'],
    ['evidencePolicy', 'ep_'],
    ['ruleOverride', 'ro_'],
    ['caseTemplate', 'tmpl_'],
    ['promptTemplate', 'pt_'],
    ['workspaceEvent', 'wse_'],
    ['intelligenceRun', 'irun_'],
    ['helperBotLog', 'hbl_'],
  ];

  it.each(prefixedCases)('generates a %s id shaped "%s<16 nanoid chars>"', (entityType, prefix) => {
    const id = generateId(entityType);
    expect(id.startsWith(prefix)).toBe(true);
    const suffix = id.slice(prefix.length);
    expect(suffix).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('does not derive ids from Date.now() (regression guard)', () => {
    // Two calls in the same tick used to collide when ids were
    // `${prefix}${Date.now()}` — nanoid-based ids never do.
    const a = generateId('token');
    const b = generateId('token');
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/^tok_\d+$/);
    expect(b).not.toMatch(/^tok_\d+$/);
  });

  it('generates a case id shaped "case-<adjective>-<noun>-<4 nanoid chars>"', () => {
    const id = generateId('case');
    expect(id).toMatch(/^case-[a-z]+-[a-z]+-[A-Za-z0-9_-]{4}$/);
  });
});

/**
 * Issue #739: `persistConflictFindings` (rule-service.ts) and the finding
 * creation sites in review-service.ts used to read-then-write with
 * `generateId('finding')`, so two concurrent evaluation runs computing the
 * same dedup signature could both observe "no existing finding" and both
 * insert a duplicate. `deriveFindingId` replaces the random suffix with one
 * derived from the signature so racing callers land on the SAME doc id
 * instead (see `lib/finding-idempotency.ts` for the create-only write that
 * closes the race).
 */
describe('deriveFindingId', () => {
  const sigA = createHash('sha256').update('a').digest('hex');
  const sigB = createHash('sha256').update('b').digest('hex');

  it('uses the same "fnd_" prefix as generateId(\'finding\') so ids stay shape-compatible', () => {
    expect(deriveFindingId(sigA).startsWith('fnd_')).toBe(true);
  });

  it('is deterministic: the same signature always derives the same id', () => {
    expect(deriveFindingId(sigA)).toBe(deriveFindingId(sigA));
  });

  it('derives different ids for different signatures', () => {
    expect(deriveFindingId(sigA)).not.toBe(deriveFindingId(sigB));
  });
});
