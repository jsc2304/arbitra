/**
 * @file chat-auth — tests for Google Chat event JWT verification.
 *
 * Rewritten once already after real dev traffic disproved the original
 * "Project Number" audience assumption (see `chat-auth.ts`'s module doc
 * for that story): the actual token shape has `iss:
 * https://accounts.google.com` (a normal Google OIDC ID token, verified
 * with Google's default certs — no custom `issuers`/`endpoints`
 * override), and the expected service account's identity is asserted in
 * the `email` claim, not `iss`.
 *
 * Extended here for a second real-traffic finding: the deployed app is
 * registered as a Google Workspace add-on, not through the classic Chat
 * API console, so the expected `email` identity is a per-project add-on
 * service agent (`service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`),
 * not the classic `chat@system.gserviceaccount.com`. See `chat-auth.ts`'s
 * "Service-account identity" doc section for the full reasoning and the
 * convert-page link.
 *
 * Tokens here are REAL RS256-signed JWTs, built with Node's own `crypto`
 * module — not stubbed `verifyIdToken` responses. Only the certs *fetch* on
 * `chatOAuthClient` is mocked (no network calls), so these tests exercise
 * the real `google-auth-library` signature/issuer/audience/expiry checks
 * against our wiring, not just a stand-in that always agrees with us.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { verifyChatEventToken, chatOAuthClient, CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL } from './chat-auth';

const AUDIENCE_ENV_KEY = 'CHAT_EVENTS_AUDIENCE';
const APP_URL_ENV_KEY = 'ARBITRA_URL';
const SERVICE_ACCOUNT_ENV_KEY = 'CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL';
const PROJECT_NUMBER_ENV_KEY = 'CHAT_PROJECT_NUMBER';
const TEST_PROJECT_NUMBER = '123456789012';
const TEST_APP_URL = 'https://arbitra.example.com';
const DEFAULT_AUDIENCE = `${TEST_APP_URL}/api/chat/events`;
const KID = 'test-kid-1';

// Must match the identity `resolveExpectedServiceAccountEmail` in chat-auth.ts
// derives from `CHAT_PROJECT_NUMBER` (64 characters here — see the comment on
// `MAX_VERIFIED_IDENTITY_LOG_LENGTH` for why the cap on the verbatim-logged
// branch is 128, not 64).
const EXPECTED_SERVICE_ACCOUNT_EMAIL = `service-${TEST_PROJECT_NUMBER}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

// A second, unrelated keypair — used only for the wrong-key-same-kid test
// below, to sign a token that claims OUR `kid` but was never actually
// signed by the private key whose public half we publish under that kid.
const { privateKey: otherPrivateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Builds a real RS256-signed JWT with the given payload — no library shortcuts. */
function signToken(
  payload: Record<string, unknown>,
  opts: { kid?: string; alg?: string; signingKey?: nodeCrypto.KeyObject; noSignature?: boolean } = {},
): string {
  const kid = opts.kid ?? KID;
  const alg = opts.alg ?? 'RS256';
  const header = { alg, typ: 'JWT', kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  if (opts.noSignature) {
    return `${signingInput}.`;
  }
  const signer = nodeCrypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign(opts.signingKey ?? privateKey, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A fully legitimate-looking payload for the observed real-traffic token shape. */
function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: DEFAULT_AUDIENCE,
    sub: '117777777777777777777',
    email: EXPECTED_SERVICE_ACCOUNT_EMAIL,
    email_verified: true,
    azp: EXPECTED_SERVICE_ACCOUNT_EMAIL,
    iat: nowSeconds() - 5,
    exp: nowSeconds() + 3600,
    ...overrides,
  };
}

/** Same as `validPayload`, but drops `email_verified` entirely rather than setting it falsy. */
function validPayloadWithoutEmailVerified(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = validPayload(overrides);
  delete payload['email_verified'];
  return payload;
}

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set('authorization', authHeader);
  return new Request('https://example.invalid/api/chat/events', { method: 'POST', headers });
}

type PatchableClient = Omit<typeof chatOAuthClient, 'getFederatedSignonCertsAsync'> & {
  getFederatedSignonCertsAsync: () => Promise<{ certs: Record<string, string>; format: string }>;
};

describe('verifyChatEventToken', () => {
  const savedAudience = process.env[AUDIENCE_ENV_KEY];
  const savedAppUrl = process.env[APP_URL_ENV_KEY];
  const savedServiceAccount = process.env[SERVICE_ACCOUNT_ENV_KEY];
  const savedProjectNumber = process.env[PROJECT_NUMBER_ENV_KEY];
  const patchable = chatOAuthClient as unknown as PatchableClient;
  const originalGetCerts = patchable.getFederatedSignonCertsAsync;

  beforeEach(() => {
    delete process.env[AUDIENCE_ENV_KEY];
    delete process.env[SERVICE_ACCOUNT_ENV_KEY];
    process.env[PROJECT_NUMBER_ENV_KEY] = TEST_PROJECT_NUMBER;
    process.env[APP_URL_ENV_KEY] = TEST_APP_URL;
    // Mock ONLY the certs fetch (the network call) — real signature, issuer,
    // audience, and expiry checks in `google-auth-library` run unmocked.
    patchable.getFederatedSignonCertsAsync = async () => ({
      certs: { [KID]: PUBLIC_KEY_PEM },
      format: 'PEM',
    });
  });

  afterEach(() => {
    if (savedAudience === undefined) delete process.env[AUDIENCE_ENV_KEY];
    else process.env[AUDIENCE_ENV_KEY] = savedAudience;
    if (savedAppUrl === undefined) delete process.env[APP_URL_ENV_KEY];
    else process.env[APP_URL_ENV_KEY] = savedAppUrl;
    if (savedServiceAccount === undefined) delete process.env[SERVICE_ACCOUNT_ENV_KEY];
    else process.env[SERVICE_ACCOUNT_ENV_KEY] = savedServiceAccount;
    if (savedProjectNumber === undefined) delete process.env[PROJECT_NUMBER_ENV_KEY];
    else process.env[PROJECT_NUMBER_ENV_KEY] = savedProjectNumber;
    patchable.getFederatedSignonCertsAsync = originalGetCerts;
  });

  /**
   * Reverting the final `return { ok: true, ... };` to `ok: false` breaks
   * this. So does reintroducing a custom `issuers: [...]` on
   * `chatOAuthClient` that excludes `https://accounts.google.com` — the
   * real observed token shape would then be rejected.
   */
  it('accepts a valid token: accounts.google.com issuer + the add-on service-agent email', async () => {
    const token = signToken(validPayload());
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(true);
    expect(result.aud).toBe(DEFAULT_AUDIENCE);
    expect(result.iss).toBe('https://accounts.google.com');
    expect(result.email).toBe(EXPECTED_SERVICE_ACCOUNT_EMAIL);
  });

  /**
   * Reverting `resolveExpectedAudience`'s derivation of the default from
   * `ARBITRA_URL` (e.g. back to a hardcoded constant) breaks this — no
   * `CHAT_EVENTS_AUDIENCE` is set here, so the ONLY way this token's
   * audience can match is the `${ARBITRA_URL}${CHAT_EVENTS_PATH}`
   * derivation.
   */
  it('derives the default audience from ARBITRA_URL + /api/chat/events when CHAT_EVENTS_AUDIENCE is unset', async () => {
    const token = signToken(validPayload({ aud: `${TEST_APP_URL}/api/chat/events` }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(true);
  });

  /**
   * Reverting the `.replace(/\/+$/, '')` trim on `ARBITRA_URL` breaks this
   * — a trailing slash on the env var would otherwise produce
   * `.../..app//api/chat/events` (double slash), which would never match
   * the token's actual `aud`.
   */
  it('strips a trailing slash from ARBITRA_URL before appending the events path', async () => {
    process.env[APP_URL_ENV_KEY] = `${TEST_APP_URL}/`;
    const token = signToken(validPayload({ aud: `${TEST_APP_URL}/api/chat/events` }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(true);
  });

  /**
   * Reverting the `audience: expectedAudience` argument in
   * `client.verifyIdToken({ idToken: token, audience: expectedAudience })`
   * (e.g. dropping it) breaks this — with no audience passed, the library
   * skips the audience check entirely and this wrong-audience token would
   * verify.
   */
  it('rejects a token with the wrong audience', async () => {
    const token = signToken(validPayload({ aud: 'https://some-other-app.example.com/api/chat/events' }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
  });

  /**
   * Rejects an arbitrary unrelated issuer — always true regardless of any
   * line here (Google's own default issuer allow-list already excludes
   * it), kept as a basic sanity check.
   */
  it('rejects a token with an unrelated issuer', async () => {
    const token = signToken(validPayload({ iss: 'https://evil.example.com' }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
  });

  /**
   * Deliberate product decision, not a bug: this repo supports ONLY the
   * "HTTP endpoint URL" token shape this app's registration sends, not the
   * older "Project Number" shape (a JWT self-signed by
   * chat@system.gserviceaccount.com itself, `iss` equal to that email).
   * Reverting `chatOAuthClient` to a client constructed with `issuers:
   * ['chat@system.gserviceaccount.com']` (the old shape) would flip this
   * test — that issuer is not in `OAuth2Client`'s own default allow-list,
   * so this stays rejected as long as no such override is reintroduced.
   */
  it('rejects the old chat@system.gserviceaccount.com self-signed-issuer shape (deliberately unsupported)', async () => {
    const token = signToken(validPayload({ iss: CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
  });

  /**
   * THE important test per the review that triggered the first rewrite: an
   * `accounts.google.com`-issued, correctly-audienced, validly-signed,
   * unexpired token is NOT sufficient on its own — it must also assert the
   * expected service account's identity. Reverting the `payload.email !==
   * resolveExpectedServiceAccountEmail() || payload.email_verified !==
   * true` check (e.g. deleting it) breaks this: without it, ANY
   * Google-issued ID token audienced at our URL — not just this Chat
   * app's — would be accepted.
   */
  it('rejects a token from the right issuer that does NOT carry the expected service-account identity', async () => {
    const token = signToken(validPayload({ email: 'someone-else@example.com', email_verified: true }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('identity_mismatch');
  });

  /**
   * Same check, other half of the `||`: the doc's own sample checks
   * `email_verified` in addition to `email` — reverting just the
   * `email_verified !== true` half of the condition (leaving the `email`
   * check standing) breaks this specific test even though the previous
   * one would still pass.
   */
  it('rejects a token with the right email but email_verified: false', async () => {
    const token = signToken(validPayload({ email_verified: false }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('identity_mismatch');
    expect(result.emailVerifiedState).toBe('false');
  });

  /**
   * Real-traffic-motivated regression: this deployment's app is a Google
   * Workspace add-on, signed by a per-project add-on service agent — NOT
   * the classic Chat-API console's `chat@system.gserviceaccount.com`.
   * Reverting `resolveExpectedServiceAccountEmail`'s default back to
   * `CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL` (i.e. "fixing" this back the way
   * a future reader might assume is correct) breaks this — the classic
   * address must stay rejected here. Also doubles as the "genuine
   * service-account address logged verbatim" case: `rejectedIdentity` is
   * still a real Google service-account domain, just not the expected
   * one, so it is logged in full rather than hashed.
   */
  it('rejects the classic chat@system.gserviceaccount.com identity and logs it verbatim (real service-account domain, wrong address)', async () => {
    const token = signToken(validPayload({ email: CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL, email_verified: true }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('identity_mismatch');
    expect(result.rejectedIdentity).toBe(CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL);
  });

  /**
   * The two causes of `identity_mismatch` ("wrong address" vs "missing
   * claim") currently produce an identical rejection — this is the
   * diagnostic that tells them apart. Reverting `normalizeEmailVerifiedState`
   * to only handle `true`/`false` (e.g. `return value ? 'true' : 'false'`,
   * collapsing `undefined` into `'false'`) breaks this — an absent claim
   * would then be indistinguishable from an explicit `false` in the logs.
   * Also proves the full expected address is not truncated on this branch
   * (`classifyRejectedIdentity`'s verbatim path caps at 128, not the 64-char
   * unverified cap).
   */
  it('rejects a correctly-addressed token with email_verified absent, distinct from an explicit false', async () => {
    const token = signToken(validPayloadWithoutEmailVerified());
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('identity_mismatch');
    expect(result.emailVerifiedState).toBe('absent');
    expect(result.rejectedIdentity).toBe(EXPECTED_SERVICE_ACCOUNT_EMAIL);
    expect(result.rejectedIdentity).toHaveLength(EXPECTED_SERVICE_ACCOUNT_EMAIL.length);
  });

  /**
   * Distinguishes the verbatim-logging cap (`MAX_VERIFIED_IDENTITY_LOG_LENGTH
   * = 128`) from the unverified-claim cap (`MAX_UNVERIFIED_CLAIM_LENGTH =
   * 64`) in a way the 64-char derived address cannot, since 64
   * fits under EITHER cap. Reverting `MAX_VERIFIED_IDENTITY_LOG_LENGTH`
   * to 64 (or reusing `MAX_UNVERIFIED_CLAIM_LENGTH` directly) truncates
   * this 90-character address at 64 chars and breaks this test.
   */
  it('logs an oversized-but-legitimate service-account identity in full, not truncated at the 64-char unverified cap', async () => {
    const longIdentity = `${'a'.repeat(48)}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
    expect(longIdentity.length).toBeGreaterThan(64);
    expect(longIdentity.length).toBeLessThanOrEqual(128);
    process.env[SERVICE_ACCOUNT_ENV_KEY] = longIdentity;
    const token = signToken(validPayload({ email: longIdentity, email_verified: false }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.rejectedIdentity).toBe(longIdentity);
  });

  /**
   * Privacy guard: classification must anchor on the PARSED domain (text
   * after the last `@`), not a substring match anywhere in the address.
   * Reverting `classifyRejectedIdentity`'s domain check to something like
   * `email.includes('gserviceaccount.com')` breaks this — that substring
   * appears in `evil-gserviceaccount.com` too, which would then be logged
   * verbatim instead of hashed.
   */
  it('hashes a hostile lookalike domain (evil-gserviceaccount.com) instead of logging it verbatim', async () => {
    const hostileEmail = 'attacker@evil-gserviceaccount.com';
    const token = signToken(validPayload({ email: hostileEmail, email_verified: true }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.rejectedIdentity).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.rejectedIdentity).not.toContain('evil');
    expect(result.rejectedIdentity).not.toContain('attacker');
  });

  /**
   * Same privacy guard, the other lookalike shape: a real
   * `gserviceaccount.com` subdomain prefix followed by an attacker-chosen
   * suffix. Reverting the domain check to a `.startsWith(...)` /
   * `.includes(...)` test (instead of an exact match or a `.` + suffix
   * match anchored at the END of the domain) breaks this — the domain
   * here starts with a legitimate-looking `gserviceaccount.com.` prefix
   * but is actually controlled by `attacker.test`.
   */
  it('hashes a hostile lookalike domain (x.gserviceaccount.com.attacker.test) instead of logging it verbatim', async () => {
    const hostileEmail = 'attacker@x.gserviceaccount.com.attacker.test';
    const token = signToken(validPayload({ email: hostileEmail, email_verified: true }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.rejectedIdentity).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.rejectedIdentity).not.toContain('attacker');
  });

  /**
   * The actual threat model for this whole classification: ANY person can
   * obtain a Google ID token audienced at our public URL, with Google
   * itself asserting their real address and `email_verified: true`.
   * Reverting the domain check to accept ordinary consumer/enterprise
   * domains (or removing the domain gate entirely, logging every rejected
   * `email` verbatim) breaks this — a real person's address must never
   * reach the logs.
   */
  it('hashes a real-person-shaped address instead of logging it verbatim', async () => {
    const personEmail = 'jane.doe@gmail.com';
    const token = signToken(validPayload({ email: personEmail, email_verified: true }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.rejectedIdentity).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.rejectedIdentity).not.toContain('jane');
    expect(result.rejectedIdentity).not.toContain('gmail');
  });

  /**
   * A non-string `email` claim must degrade to a literal, not throw.
   * Reverting `classifyRejectedIdentity`'s `typeof email !== 'string'`
   * guard back to a bare `if (!email)` makes `email.indexOf` throw on a
   * number, and this branch has no try/catch above it — on a route Google
   * retries for 5xx, that turns a clean 401 into a retried 500.
   */
  it('returns a literal for a non-string email claim instead of throwing', async () => {
    const token = signToken(validPayload({ email: 12345, email_verified: true }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.rejectedIdentity).toBe('no_email_claim');
  });

  /**
   * Parsing the domain from the LAST `@` classifies this as a service
   * account and logs a real person's address verbatim. Reverting
   * `classifyRejectedIdentity`'s second-`@` rejection (or switching
   * `indexOf` back to `lastIndexOf`) flips it to the verbatim branch.
   * Unreachable through Google-signed traffic — Google will not issue an
   * `email` claim containing two `@` — but the failure mode is a personal
   * address in the logs, so the guard is cheap insurance.
   */
  it('treats a double-@ address as malformed rather than logging it verbatim', async () => {
    const token = signToken(
      validPayload({ email: 'jane.doe@gmail.com@gserviceaccount.com', email_verified: true }),
    );
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.rejectedIdentity).toBe('malformed_email_claim');
    expect(result.rejectedIdentity).not.toContain('gmail');
  });

  /** Reverting `classifyRejectedIdentity`'s `if (!email) return 'no_email_claim';` breaks this. */
  it('logs a fixed literal, not a hash, when the email claim is absent', async () => {
    const payload = validPayload();
    delete payload['email'];
    const token = signToken(payload);
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.rejectedIdentity).toBe('no_email_claim');
  });

  /**
   * Reverting `resolveExpectedServiceAccountEmail`'s `if (configured &&
   * configured.trim()) return configured.trim();` (e.g. always deriving
   * the add-on default regardless of the env var) breaks this — the
   * override would never be honored and this token would fail as
   * identity_mismatch instead of verifying.
   */
  it('honors CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL when set, overriding the inferred add-on default', async () => {
    const overrideEmail = 'service-999999999999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';
    process.env[SERVICE_ACCOUNT_ENV_KEY] = overrideEmail;
    const token = signToken(validPayload({ email: overrideEmail, email_verified: true }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(true);
    expect(result.email).toBe(overrideEmail);
  });

  /**
   * Fail-closed config check. Reverting the `if (!expectedEmail)` guard in
   * `verifyChatEventToken` (or giving `resolveExpectedServiceAccountEmail`
   * a built-in default project number) breaks this — a perfectly valid
   * token would then verify against whatever default was baked in.
   */
  it('fails closed when neither CHAT_PROJECT_NUMBER nor CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL is set', async () => {
    delete process.env[PROJECT_NUMBER_ENV_KEY];
    const token = signToken(validPayload());
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('chat_project_not_configured');
  });

  it('treats a blank CHAT_PROJECT_NUMBER as unset (fail closed)', async () => {
    process.env[PROJECT_NUMBER_ENV_KEY] = '   ';
    const token = signToken(validPayload());
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('chat_project_not_configured');
  });

  it('accepts the service-account override without CHAT_PROJECT_NUMBER', async () => {
    delete process.env[PROJECT_NUMBER_ENV_KEY];
    process.env[SERVICE_ACCOUNT_ENV_KEY] = EXPECTED_SERVICE_ACCOUNT_EMAIL;
    const token = signToken(validPayload());
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(true);
  });

  /**
   * Reverting the `catch (_err) { return { ok: false, reason:
   * 'token_verification_failed', ... }; }` block — e.g. changing it to
   * return `{ ok: true }` regardless — breaks this. Expiry itself is
   * enforced by the real (unmocked) `google-auth-library` call; this is
   * the line in our own code that turns that rejection into a clean
   * `ok: false` instead of letting the exception propagate or papering
   * over it.
   */
  it('rejects an expired token', async () => {
    const token = signToken(validPayload({ iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
  });

  /**
   * Reverting `if (!authHeader) { return { ok: false, reason:
   * 'no_authorization_header' }; }` breaks this — without it, a missing
   * header falls through to the Bearer regex against `null`, which is a
   * different (and untested-for-401) failure path.
   */
  it('rejects a request with no Authorization header', async () => {
    const result = await verifyChatEventToken(makeRequest());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_authorization_header');
  });

  /**
   * Reverting the `/^Bearer\s+(.+)$/i.exec(...)` guard (e.g. accepting any
   * header value as a token) breaks this.
   */
  it('rejects a malformed Authorization header', async () => {
    const result = await verifyChatEventToken(makeRequest('NotBearer foo'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed_bearer');
  });

  /**
   * Reverting `resolveExpectedAudience`'s `if (configured &&
   * configured.trim()) return configured.trim();` (e.g. always deriving
   * from `ARBITRA_URL` regardless of the env var) breaks this — the
   * override would never be honored and this token would fail as
   * wrong-audience.
   */
  it('honors CHAT_EVENTS_AUDIENCE when set, overriding the ARBITRA_URL-derived default', async () => {
    process.env[AUDIENCE_ENV_KEY] = 'https://custom.example.com/hook';
    const token = signToken(validPayload({ aud: 'https://custom.example.com/hook' }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(true);
  });

  /**
   * Reverting `record['iss'].slice(0, MAX_UNVERIFIED_CLAIM_LENGTH)` (or
   * `MAX_UNVERIFIED_CLAIM_LENGTH` itself) back to the raw, uncapped claim
   * breaks this — a caller fully controls `iss`/`aud` on this failure path
   * (no signature has been checked yet), so an oversized value would
   * otherwise be logged verbatim on every rejection.
   */
  it('caps an oversized unverified iss/aud claim at 64 chars on a rejected token', async () => {
    const hugeIss = 'x'.repeat(4000);
    const hugeAud = 'y'.repeat(4000);
    const token = signToken(validPayload({ iss: hugeIss, aud: hugeAud }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    expect(result.iss).toHaveLength(64);
    expect(result.iss).toBe(hugeIss.slice(0, 64));
    expect(result.aud).toHaveLength(64);
    expect(result.aud).toBe(hugeAud.slice(0, 64));
  });

  /**
   * Regression pin — already rejected today because `crypto.verify`
   * (inside `google-auth-library`) fails on a signature produced by a
   * different private key, regardless of what `kid` the token's header
   * claims. Would break if the certs map were ever keyed by something
   * weaker than an exact `kid` match, or if signature verification were
   * ever skipped.
   */
  it('rejects a token whose kid matches but was signed by a different private key', async () => {
    const token = signToken(validPayload(), { signingKey: otherPrivateKey });
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
  });

  /**
   * Regression pin — already rejected today because
   * `verifySignedJwtWithCertsAsync` always attempts a real signature
   * verification regardless of the `alg` header's value; an empty
   * signature segment fails that check.
   */
  it('rejects an alg:none token with an empty signature', async () => {
    const token = signToken(validPayload(), { alg: 'none', noSignature: true });
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
  });

  /**
   * Regression pin — already rejected today because we pass a single
   * string as `audience` to `verifyIdToken`, and the library's own
   * audience check (`aud === requiredAudience`) is false whenever `aud` is
   * an array, even if that array contains the right value.
   */
  it('rejects a token whose aud is an array instead of a string', async () => {
    const token = signToken(validPayload({ aud: [DEFAULT_AUDIENCE, 'some-other-audience'] }));
    const result = await verifyChatEventToken(makeRequest(`Bearer ${token}`));
    expect(result.ok).toBe(false);
  });
});

describe('chatOAuthClient construction', () => {
  /**
   * Reintroducing a custom `issuers` or `endpoints` option on
   * `chatOAuthClient` (e.g. pinning it back to
   * `chat@system.gserviceaccount.com` and its certs endpoint, as the
   * previous version of this module did) breaks this — this is the
   * regression guard for exactly the mistake that caused the first
   * rewrite: a narrower-than-default client silently rejecting the real
   * token shape.
   */
  it('is constructed with no custom issuers or endpoints override', () => {
    const bareClient = new OAuth2Client();
    expect(chatOAuthClient.issuers).toEqual(bareClient.issuers);
    expect(chatOAuthClient.endpoints).toEqual(bareClient.endpoints);
  });
});
