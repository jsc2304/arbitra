import { describe, it, expect } from 'vitest';
import { highRiskWithoutFourEyesDetector } from '../detectors/high-risk-without-four-eyes.js';
import { makeCase, makeDecision, makeStubContext } from './test-helpers.js';

describe('highRiskWithoutFourEyesDetector', () => {
  it('flags a done high-risk case with only one approver', async () => {
    const c = makeCase({ case_id: 'case_lonely', status: 'done', risk_level: 'high' });
    const ctx = makeStubContext({
      cases: [c],
      decisionsByCase: {
        case_lonely: [makeDecision({ type: 'approve', actor_id: 'usr_only' })],
      },
    });
    const results = await highRiskWithoutFourEyesDetector.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].evidence.approver_count).toBe(1);
    expect(results[0].evidence.approver_ids).toEqual(['usr_only']);
  });

  it('passes when two distinct human approvers signed off', async () => {
    const c = makeCase({ case_id: 'case_fine', status: 'done', risk_level: 'critical' });
    const ctx = makeStubContext({
      cases: [c],
      decisionsByCase: {
        case_fine: [
          makeDecision({ type: 'approve', actor_id: 'usr_a' }),
          makeDecision({ type: 'approve', actor_id: 'usr_b' }),
        ],
      },
    });
    expect(await highRiskWithoutFourEyesDetector.run(ctx)).toHaveLength(0);
  });

  it('excludes system actors when counting approvers', async () => {
    const c = makeCase({ case_id: 'case_sys', status: 'done', risk_level: 'high' });
    const ctx = makeStubContext({
      cases: [c],
      decisionsByCase: {
        case_sys: [
          makeDecision({ type: 'approve', actor_id: 'usr_human' }),
          makeDecision({ type: 'auto_approve', actor_id: 'system:runner' }),
        ],
      },
    });
    const results = await highRiskWithoutFourEyesDetector.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].evidence.approver_count).toBe(1);
  });

  it('ignores low/medium risk cases', async () => {
    const c = makeCase({ case_id: 'case_low', status: 'done', risk_level: 'medium' });
    const ctx = makeStubContext({ cases: [c] });
    expect(await highRiskWithoutFourEyesDetector.run(ctx)).toHaveLength(0);
  });

  it('ignores non-done cases', async () => {
    const c = makeCase({ case_id: 'case_open', status: 'in_review', risk_level: 'critical' });
    const ctx = makeStubContext({ cases: [c] });
    expect(await highRiskWithoutFourEyesDetector.run(ctx)).toHaveLength(0);
  });
});
