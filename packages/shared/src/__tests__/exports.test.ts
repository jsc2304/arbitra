import { describe, it, expect } from 'vitest';
import * as shared from '../index.js';

// ── Verify all expected exports exist ───────────────────────────────

describe('shared package exports', () => {
  // ── Constants ──

  describe('constants/status-transitions', () => {
    it('exports TRANSITION_MATRIX', () => {
      expect(shared.TRANSITION_MATRIX).toBeDefined();
      expect(Array.isArray(shared.TRANSITION_MATRIX)).toBe(true);
    });

    it('exports getTransitionsFrom', () => {
      expect(typeof shared.getTransitionsFrom).toBe('function');
    });

    it('exports findTransition', () => {
      expect(typeof shared.findTransition).toBe('function');
    });
  });

  describe('constants/risk-levels', () => {
    it('exports RISK_LEVELS', () => {
      expect(shared.RISK_LEVELS).toBeDefined();
      expect(Array.isArray(shared.RISK_LEVELS)).toBe(true);
      expect(shared.RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
    });

    it('exports RISK_LEVEL_ORDER', () => {
      expect(shared.RISK_LEVEL_ORDER).toBeDefined();
      expect(typeof shared.RISK_LEVEL_ORDER).toBe('object');
    });

    it('exports isHighRisk', () => {
      expect(typeof shared.isHighRisk).toBe('function');
      expect(shared.isHighRisk('low')).toBe(false);
      expect(shared.isHighRisk('medium')).toBe(false);
      expect(shared.isHighRisk('high')).toBe(true);
      expect(shared.isHighRisk('critical')).toBe(true);
    });

    it('exports compareRiskLevels', () => {
      expect(typeof shared.compareRiskLevels).toBe('function');
      expect(shared.compareRiskLevels('low', 'critical')).toBeLessThan(0);
      expect(shared.compareRiskLevels('critical', 'low')).toBeGreaterThan(0);
      expect(shared.compareRiskLevels('medium', 'medium')).toBe(0);
    });
  });

  describe('constants/evidence-policy-defaults', () => {
    it('exports DEFAULT_DIRECT_TRACK_POLICY', () => {
      expect(shared.DEFAULT_DIRECT_TRACK_POLICY).toBeDefined();
      expect(typeof shared.DEFAULT_DIRECT_TRACK_POLICY).toBe('object');
    });

    it('exports DEFAULT_MANUAL_TRACK_POLICY', () => {
      expect(shared.DEFAULT_MANUAL_TRACK_POLICY).toBeDefined();
      expect(typeof shared.DEFAULT_MANUAL_TRACK_POLICY).toBe('object');
    });

    it('exports getDefaultPolicyRule', () => {
      expect(typeof shared.getDefaultPolicyRule).toBe('function');
    });
  });

  // ── Validation schemas ──

  describe('validation/case-validators', () => {
    it('exports createCaseSchema', () => {
      expect(shared.createCaseSchema).toBeDefined();
    });

    it('exports updateCaseSchema', () => {
      expect(shared.updateCaseSchema).toBeDefined();
    });

    it('exports caseFiltersSchema', () => {
      expect(shared.caseFiltersSchema).toBeDefined();
    });
  });

  describe('validation/transition-validators', () => {
    it('exports transitionRequestSchema', () => {
      expect(shared.transitionRequestSchema).toBeDefined();
    });
  });

  describe('validation/evidence-validators', () => {
    it('exports createEvidenceSchema', () => {
      expect(shared.createEvidenceSchema).toBeDefined();
    });
  });

  describe('validation/decision-validators', () => {
    it('exports createDecisionSchema', () => {
      expect(shared.createDecisionSchema).toBeDefined();
    });
  });

  describe('validation/comment-validators', () => {
    it('exports createCommentSchema', () => {
      expect(shared.createCommentSchema).toBeDefined();
    });
  });

  describe('validation/artifact-validators', () => {
    it('exports inlineAttachmentSchema', () => {
      expect(shared.inlineAttachmentSchema).toBeDefined();
    });

    it('exports gitContextSchema', () => {
      expect(shared.gitContextSchema).toBeDefined();
    });

    it('exports createArtifactSchema', () => {
      expect(shared.createArtifactSchema).toBeDefined();
    });
  });

  // ── Errors ──

  describe('errors/arbitra-error', () => {
    it('exports ArbitraError', () => {
      expect(shared.ArbitraError).toBeDefined();
      const err = new shared.ArbitraError('test', 'TEST', 400);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('TEST');
      expect(err.statusCode).toBe(400);
    });

    it('exports NotFoundError', () => {
      expect(shared.NotFoundError).toBeDefined();
      const err = new shared.NotFoundError('Case', 'case-1');
      expect(err).toBeInstanceOf(shared.ArbitraError);
      expect(err.statusCode).toBe(404);
    });

    it('exports ForbiddenError', () => {
      expect(shared.ForbiddenError).toBeDefined();
      const err = new shared.ForbiddenError('Not allowed');
      expect(err).toBeInstanceOf(shared.ArbitraError);
      expect(err.statusCode).toBe(403);
    });

    it('exports UnauthorizedError', () => {
      expect(shared.UnauthorizedError).toBeDefined();
      const err = new shared.UnauthorizedError();
      expect(err).toBeInstanceOf(shared.ArbitraError);
      expect(err.statusCode).toBe(401);
    });

    it('exports ValidationError', () => {
      expect(shared.ValidationError).toBeDefined();
      const err = new shared.ValidationError('Invalid input');
      expect(err).toBeInstanceOf(shared.ArbitraError);
      expect(err.statusCode).toBe(400);
    });
  });

  describe('errors/transition-error', () => {
    it('exports TransitionError', () => {
      expect(shared.TransitionError).toBeDefined();
      const err = new shared.TransitionError('open', 'done', []);
      expect(err).toBeInstanceOf(shared.ArbitraError);
      expect(err.statusCode).toBe(409);
      expect(err.fromStatus).toBe('open');
      expect(err.toStatus).toBe('done');
    });
  });

  // ── ArbitraError.toJSON ──

  describe('ArbitraError.toJSON', () => {
    it('returns structured error JSON', () => {
      const err = new shared.ArbitraError('Something broke', 'BROKEN', 500, { field: 'title' });
      const json = err.toJSON();
      expect(json).toEqual({
        error: {
          code: 'BROKEN',
          message: 'Something broke',
          details: { field: 'title' },
        },
      });
    });
  });
});
