import { describe, it, expect } from 'vitest';
import { resolveTabParam } from './resolve-tab-param';

describe('resolveTabParam', () => {
  it('returns proof + findings when no tab param is set', () => {
    expect(resolveTabParam(null, null)).toEqual({ tab: 'proof', proofExpand: 'findings' });
  });

  it('routes ?tab=proof to the proof tab with findings expanded by default', () => {
    expect(resolveTabParam('proof', null)).toEqual({ tab: 'proof', proofExpand: 'findings' });
  });

  it('routes legacy ?tab=dossier to the proof tab with findings expanded', () => {
    expect(resolveTabParam('dossier', null)).toEqual({ tab: 'proof', proofExpand: 'findings' });
  });

  it('honours ?section= on the canonical proof tab', () => {
    expect(resolveTabParam('proof', 'evidence')).toEqual({ tab: 'proof', proofExpand: 'evidence' });
    expect(resolveTabParam('proof', 'decisions')).toEqual({ tab: 'proof', proofExpand: 'decisions' });
  });

  it('honours ?section= on the legacy dossier alias (deep-links from the standalone print page)', () => {
    expect(resolveTabParam('dossier', 'findings')).toEqual({ tab: 'proof', proofExpand: 'findings' });
    expect(resolveTabParam('dossier', 'evidence')).toEqual({ tab: 'proof', proofExpand: 'evidence' });
    expect(resolveTabParam('dossier', 'decisions')).toEqual({ tab: 'proof', proofExpand: 'decisions' });
  });

  it('treats legacy section-style tab params (?tab=findings|evidence|decisions) as proof-tab section shortcuts', () => {
    expect(resolveTabParam('findings', null)).toEqual({ tab: 'proof', proofExpand: 'findings' });
    expect(resolveTabParam('evidence', null)).toEqual({ tab: 'proof', proofExpand: 'evidence' });
    expect(resolveTabParam('decisions', null)).toEqual({ tab: 'proof', proofExpand: 'decisions' });
  });

  it('passes through known non-proof tabs without setting proofExpand', () => {
    expect(resolveTabParam('runs', null)).toEqual({ tab: 'runs', proofExpand: undefined });
    expect(resolveTabParam('timeline', null)).toEqual({ tab: 'timeline', proofExpand: undefined });
    expect(resolveTabParam('comments', null)).toEqual({ tab: 'comments', proofExpand: undefined });
    expect(resolveTabParam('related', null)).toEqual({ tab: 'related', proofExpand: undefined });
  });

  it('falls back to proof + findings for unknown tab values', () => {
    expect(resolveTabParam('garbage', null)).toEqual({ tab: 'proof', proofExpand: 'findings' });
  });

  it('ignores unknown ?section= values on proof/dossier and falls through to default expand', () => {
    // Unknown section -> not matched by SECTION_VALUES guard; for `proof` falls to
    // the TAB_IDS branch (findings); for `dossier` falls to the legacy-alias branch (findings).
    expect(resolveTabParam('proof', 'bogus')).toEqual({ tab: 'proof', proofExpand: 'findings' });
    expect(resolveTabParam('dossier', 'bogus')).toEqual({ tab: 'proof', proofExpand: 'findings' });
  });
});
