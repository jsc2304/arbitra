/**
 * @file scheduler-auth — tests for the multi-SA / multi-audience OIDC
 * verifier.
 *
 * The verifier merges the legacy singular env vars (`SCHEDULER_SA_EMAIL`,
 * `SCHEDULER_OIDC_AUDIENCE`) with the new comma-separated plural vars
 * (`SCHEDULER_SA_EMAILS`, `SCHEDULER_OIDC_AUDIENCES`). These tests cover the
 * four configuration combinations plus the negative paths (bad header, bad
 * token, audience or SA not in allow-list, email_verified=false).
 *
 * `OAuth2Client.verifyIdToken` is stubbed via the injected `client` argument;
 * we never go to Google.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuth2Client } from 'google-auth-library';
import { verifySchedulerOidc } from './scheduler-auth';

type Payload = {
  aud?: string;
  email?: string;
  email_verified?: boolean;
};

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set('authorization', authHeader);
  return new Request('https://example.invalid/api/intelligence/run', {
    method: 'POST',
    headers,
  });
}

function makeClient(opts: {
  payload?: Payload | null;
  throwOnVerify?: boolean;
}): { client: OAuth2Client; verifyIdToken: ReturnType<typeof vi.fn> } {
  const verifyIdToken = vi.fn(async () => {
    if (opts.throwOnVerify) throw new Error('bad signature');
    return {
      getPayload: () => opts.payload ?? null,
    };
  });
  const client = { verifyIdToken } as unknown as OAuth2Client;
  return { client, verifyIdToken };
}

const ENV_KEYS = [
  'SCHEDULER_SA_EMAIL',
  'SCHEDULER_OIDC_AUDIENCE',
  'SCHEDULER_SA_EMAILS',
  'SCHEDULER_OIDC_AUDIENCES',
  'ARBITRA_CRON_SECRET',
] as const;

describe('verifySchedulerOidc', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('ARBITRA_CRON_SECRET', () => {
    /** Reverts: the matchesCronSecret() short-circuit. */
    it('accepts the configured shared secret without OIDC', async () => {
      process.env['ARBITRA_CRON_SECRET'] = 'a-long-random-cron-secret';
      const { client } = makeClient({ throwOnVerify: true });
      const result = await verifySchedulerOidc(makeRequest('Bearer a-long-random-cron-secret'), client);
      expect(result).toEqual({ ok: true });
    });

    it('rejects a wrong secret as a caller error, not a misconfiguration', async () => {
      process.env['ARBITRA_CRON_SECRET'] = 'a-long-random-cron-secret';
      const { client } = makeClient({ throwOnVerify: true });
      const result = await verifySchedulerOidc(makeRequest('Bearer a-long-random-cron-secreT'), client);
      expect(result).toEqual({ ok: false, reason: 'cron_secret_mismatch' });
    });

    it('still accepts a valid OIDC token when both mechanisms are configured', async () => {
      process.env['ARBITRA_CRON_SECRET'] = 'a-long-random-cron-secret';
      process.env['SCHEDULER_SA_EMAIL'] = 'sa@example.iam.gserviceaccount.com';
      process.env['SCHEDULER_OIDC_AUDIENCE'] = 'https://svc.example/api/intelligence/run';
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/intelligence/run',
          email: 'sa@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer oidc-token'), client);
      expect(result).toEqual({ ok: true });
    });
  });

  it('returns oidc_not_configured when nothing is set', async () => {
    const { client } = makeClient({ payload: null });
    const result = await verifySchedulerOidc(makeRequest('Bearer x'), client);
    expect(result).toEqual({ ok: false, reason: 'oidc_not_configured' });
  });

  it('returns oidc_not_configured when only one var family is set', async () => {
    process.env['SCHEDULER_SA_EMAIL'] = 'sa@example.iam.gserviceaccount.com';
    const { client } = makeClient({ payload: null });
    const result = await verifySchedulerOidc(makeRequest('Bearer x'), client);
    expect(result).toEqual({ ok: false, reason: 'oidc_not_configured' });
  });

  describe('singular-only (backward compat)', () => {
    beforeEach(() => {
      process.env['SCHEDULER_SA_EMAIL'] = 'sa@example.iam.gserviceaccount.com';
      process.env['SCHEDULER_OIDC_AUDIENCE'] = 'https://svc.example/api/intelligence/run';
    });

    it('accepts a token matching the singular SA + audience', async () => {
      const { client, verifyIdToken } = makeClient({
        payload: {
          aud: 'https://svc.example/api/intelligence/run',
          email: 'sa@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: true });
      expect(verifyIdToken).toHaveBeenCalledWith({
        idToken: 'abc',
        audience: ['https://svc.example/api/intelligence/run'],
      });
    });

    it('rejects when the SA email does not match', async () => {
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/intelligence/run',
          email: 'attacker@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: false, reason: 'sa_email_mismatch' });
    });
  });

  describe('plural-only (new path)', () => {
    beforeEach(() => {
      process.env['SCHEDULER_SA_EMAILS'] =
        'sa-a@example.iam.gserviceaccount.com,sa-b@example.iam.gserviceaccount.com';
      process.env['SCHEDULER_OIDC_AUDIENCES'] =
        'https://svc.example/api/intelligence/run,https://svc.example/api/blueprints/tick';
    });

    it('accepts the first allowed (SA, audience) pair', async () => {
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/intelligence/run',
          email: 'sa-a@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: true });
    });

    it('accepts the second allowed (SA, audience) pair', async () => {
      const { client, verifyIdToken } = makeClient({
        payload: {
          aud: 'https://svc.example/api/blueprints/tick',
          email: 'sa-b@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: true });
      expect(verifyIdToken).toHaveBeenCalledWith({
        idToken: 'abc',
        audience: [
          'https://svc.example/api/intelligence/run',
          'https://svc.example/api/blueprints/tick',
        ],
      });
    });

    it('rejects an audience not in the allow-list', async () => {
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/other',
          email: 'sa-a@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: false, reason: 'audience_mismatch' });
    });

    it('rejects an SA not in the allow-list', async () => {
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/intelligence/run',
          email: 'sa-c@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: false, reason: 'sa_email_mismatch' });
    });

    it('rejects when email_verified is false', async () => {
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/intelligence/run',
          email: 'sa-a@example.iam.gserviceaccount.com',
          email_verified: false,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: false, reason: 'email_not_verified' });
    });
  });

  describe('singular + plural both set (union semantics)', () => {
    beforeEach(() => {
      process.env['SCHEDULER_SA_EMAIL'] = 'sa-legacy@example.iam.gserviceaccount.com';
      process.env['SCHEDULER_OIDC_AUDIENCE'] = 'https://svc.example/api/intelligence/run';
      process.env['SCHEDULER_SA_EMAILS'] = 'sa-new@example.iam.gserviceaccount.com';
      process.env['SCHEDULER_OIDC_AUDIENCES'] = 'https://svc.example/api/blueprints/tick';
    });

    it('accepts a token signed for the legacy (singular) pair', async () => {
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/intelligence/run',
          email: 'sa-legacy@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: true });
    });

    it('accepts a token signed for the new (plural) pair', async () => {
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/blueprints/tick',
          email: 'sa-new@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: true });
    });

    it('de-duplicates overlapping values across singular and plural', async () => {
      process.env['SCHEDULER_SA_EMAILS'] =
        'sa-legacy@example.iam.gserviceaccount.com,sa-new@example.iam.gserviceaccount.com';
      const { client, verifyIdToken } = makeClient({
        payload: {
          aud: 'https://svc.example/api/intelligence/run',
          email: 'sa-legacy@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result.ok).toBe(true);
      // Audience list passed to google-auth-library should not contain dupes.
      const call = verifyIdToken.mock.calls[0]?.[0] as { audience: string[] };
      const auds = call.audience;
      expect(new Set(auds).size).toBe(auds.length);
    });

    it('trims whitespace around comma-separated entries', async () => {
      process.env['SCHEDULER_SA_EMAILS'] = '  sa-spaced@example.iam.gserviceaccount.com  ';
      process.env['SCHEDULER_OIDC_AUDIENCES'] = '  https://svc.example/api/spaced  ';
      const { client } = makeClient({
        payload: {
          aud: 'https://svc.example/api/spaced',
          email: 'sa-spaced@example.iam.gserviceaccount.com',
          email_verified: true,
        },
      });
      const result = await verifySchedulerOidc(makeRequest('Bearer abc'), client);
      expect(result).toEqual({ ok: true });
    });
  });

  describe('header / token surface', () => {
    beforeEach(() => {
      process.env['SCHEDULER_SA_EMAIL'] = 'sa@example.iam.gserviceaccount.com';
      process.env['SCHEDULER_OIDC_AUDIENCE'] = 'https://svc.example/api/intelligence/run';
    });

    it('rejects when the Authorization header is missing', async () => {
      const { client } = makeClient({ payload: null });
      const result = await verifySchedulerOidc(makeRequest(undefined), client);
      expect(result).toEqual({ ok: false, reason: 'no_authorization_header' });
    });

    it('rejects a non-Bearer header', async () => {
      const { client } = makeClient({ payload: null });
      const result = await verifySchedulerOidc(makeRequest('Basic abc'), client);
      expect(result).toEqual({ ok: false, reason: 'malformed_bearer' });
    });

    it('rejects when verifyIdToken throws', async () => {
      const { client } = makeClient({ throwOnVerify: true });
      const result = await verifySchedulerOidc(makeRequest('Bearer bad'), client);
      expect(result).toEqual({ ok: false, reason: 'token_verification_failed' });
    });

    it('rejects when payload is missing', async () => {
      const { client } = makeClient({ payload: null });
      const result = await verifySchedulerOidc(makeRequest('Bearer ok'), client);
      expect(result).toEqual({ ok: false, reason: 'token_payload_missing' });
    });
  });
});
