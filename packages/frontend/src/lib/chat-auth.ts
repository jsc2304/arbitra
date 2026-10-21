import { OAuth2Client } from 'google-auth-library';
import * as nodeCrypto from 'node:crypto';

/**
 * Verifies the Google-signed bearer JWT Google Chat attaches to every
 * `POST /api/chat/events` call (`docs/specs/clerk-config-scheduling-chat.md`
 * Slice E).
 *
 * ## What changed, and why
 *
 * The first version of this module assumed the "Project Number" audience
 * configuration described in Google's docs
 * (https://developers.google.com/workspace/chat/verify-requests-from-chat):
 * a JWT self-signed by `chat@system.gserviceaccount.com`, verified against
 * that service account's own certs endpoint with `issuers:
 * [CHAT_SERVICE_ACCOUNT_EMAIL]`.
 *
 * That assumption does not hold for this app's registration, whose tokens
 * carry `iss=https://accounts.google.com` and
 * `aud=https://arbitra.example.com/api/chat/events`.
 * That is the OTHER configuration the same doc describes — "HTTP endpoint
 * URL" audience — and it is a materially different token:
 *
 *   - It is a standard Google-signed OIDC ID token, not a JWT self-signed by
 *     the Chat service account. Its `iss` is the normal Google ID-token
 *     issuer (`https://accounts.google.com`), verifiable with Google's
 *     ordinary federated OIDC certs — i.e. a DEFAULT-constructed
 *     `OAuth2Client`, no custom `issuers`/`endpoints` override.
 *   - The Chat service account's identity is NOT the issuer. Per the same
 *     doc's own Node.js sample for this configuration, it is asserted in
 *     the `email` claim, checked alongside `email_verified`:
 *
 *       return ticket.getPayload().email_verified
 *           && ticket.getPayload().email === chatIssuer; // 'chat@system.gserviceaccount.com'
 *
 *     This is NOT optional. `iss: https://accounts.google.com` alone is a
 *     far weaker statement than "signed by the Chat service account" — an
 *     enormous number of unrelated Google-issued ID tokens satisfy it
 *     (anything requested with `audience` set to our URL). The `email`
 *     check is what narrows "signed by Google" down to "asserted by a
 *     specific service account" — see the next section for WHICH one is
 *     correct for this deployment — and `email_verified` is standard OIDC
 *     hygiene the doc's own sample checks first.
 *
 * `chatOAuthClient` below is therefore a plain, default-constructed
 * `OAuth2Client` (matching the doc's sample exactly), and
 * `verifyChatEventToken` adds the `email`/`email_verified` check itself —
 * `verifyIdToken` has no option to enforce that on its own.
 *
 * ## One issuer, not two
 *
 * Google's doc describes both configurations as valid, but this module
 * supports ONLY the "HTTP endpoint URL" / `accounts.google.com` shape —
 * the one this app's registration sends and the only one a
 * test here can exercise. Also accepting the old
 * "Project Number" / self-signed-JWT shape would widen the trust boundary
 * (two independent verification paths, either sufficient) for a format we
 * have no evidence this console configuration ever sends, and no way to
 * test against anything but a self-signed fixture. If the console
 * configuration ever changes to send that shape too, the fix is to widen
 * this deliberately, with the same kind of real-traffic evidence that
 * caused this rewrite — not to guess ahead of it. An unrecognized issuer
 * fails closed (401) like any other verification failure.
 *
 * ## Service-account identity — add-on registration, not classic
 *
 * `chat@system.gserviceaccount.com` (`CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL`
 * below) is the address the doc's sample checks — but it is the address
 * for the "classic" Chat-API interaction-events console registration.
 * This app is registered as a **Google Workspace add-on extending Google
 * Chat**, which is a different registration shape signed by a different
 * identity: a per-project add-on service agent, not the shared
 * `chat@system.gserviceaccount.com`. Google's own convert-page
 * (https://developers.google.com/workspace/add-ons/chat/convert) tabulates
 * exactly this split — classic: audience "Project number", email
 * `chat@system.gserviceaccount.com`; add-on: audience "HTTP endpoint
 * only", email "Per-project service account email". This app's
 * registration matches the add-on row on both counts (HTTP-endpoint audience, above;
 * and — see below — not the classic email). Google's add-on samples
 * (https://github.com/googleworkspace/add-ons-samples/blob/main/node/chat/secured-app/index.js)
 * check the per-project agent, not the classic address.
 *
 * The expected identity is `service-<project
 * number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com` — Google's standard
 * per-project service-agent naming for the `gsuiteaddons` API — derived from
 * the `CHAT_PROJECT_NUMBER` env var (see below). The pattern is
 * AUTHORITATIVE, not guessed: `gcloud workspace-add-ons
 * get-authorization --project <project id>` returns
 * `serviceAccountEmail: service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`.
 * (That command needs the `gsuiteaddons` API enabled.)
 *
 * What is still NOT confirmed is `email_verified`. Google's own add-on
 * samples disagree — the Python one omits the check that Node and Java
 * perform — and an absent claim rejects here exactly like a wrong
 * address. That is why the `identity_mismatch` branch below logs the
 * classified rejected identity AND the `email_verified` state: the two
 * causes are indistinguishable from a bare rejection, and each costs a
 * human sending another Chat message to diagnose. If an observed address
 * ever disagrees with the default, override it via
 * `CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL` (see below) rather than editing the
 * code.
 *
 * IMPORTANT for future readers: do NOT "fix" this back to
 * `chat@system.gserviceaccount.com`. That address is correct for a
 * classic-console registration; it is a materially different, and wrong,
 * value for this add-on registration. Only widen or change acceptance
 * here again with the same kind of real-traffic evidence that produced
 * this pin, per the "one issuer, not two" reasoning above — the identical
 * argument applies to identities as it does to issuers: accepting both
 * the classic and add-on addresses would widen the trust boundary for a
 * registration shape this deployment does not have.
 *
 * ## Audience — `CHAT_EVENTS_AUDIENCE`
 *
 *   Google Chat's "HTTP endpoint URL" configuration sets the token's `aud`
 *   claim to the exact endpoint URL configured in the console — confirmed
 *   by the observed `aud=https://arbitra.example.com/api/chat/events`.
 *
 *   Default: `${ARBITRA_URL}/api/chat/events`. `ARBITRA_URL` is the
 *   instance's public base URL, already set per environment at deploy time —
 *   reusing it here rather than hardcoding a second copy of the hostname
 *   means every environment gets its own correct default
 *   automatically. `CHAT_EVENTS_AUDIENCE` stays
 *   available to override this, e.g. if the console's endpoint path or host
 *   ever diverges from `ARBITRA_URL` + `/api/chat/events`.
 *
 *   Whichever value is live in the console MUST be copied into this env
 *   var (or match `ARBITRA_URL` + the fixed path) verbatim — a mismatch
 *   here fails every event with a 401.
 *
 *   The audience VALUE is configurable; verification itself is not — there
 *   is no env var that disables or weakens the checks below.
 *
 * ## Identity — `CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL`
 *
 *   Default: the add-on service-agent address derived from
 *   `CHAT_PROJECT_NUMBER` (the numeric number — not the id — of the GCP
 *   project the Chat app / Workspace add-on is registered in; see
 *   `resolveExpectedServiceAccountEmail`). Override with
 *   `CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL` if the derived default turns out to
 *   be wrong once a real message confirms or disproves it — no code change
 *   needed for that correction.
 *
 *   Fail closed: with NEITHER env var set there is no expected identity, so
 *   every request is rejected (`chat_project_not_configured`). There is no
 *   built-in default project number.
 *
 * `verifyChatEventToken` reports the `aud`/`iss` it actually saw on every
 * failure and, once per process, the VERIFIED `aud`/`iss`/`email` of the
 * first request that passes every check — confirming all three at once.
 *
 * On the `token_verification_failed` / `token_payload_missing` branches,
 * verification did not complete — those `aud`/`iss` values are
 * attacker-controlled (no signature has been checked yet), best-effort
 * decoded, and capped at `MAX_UNVERIFIED_CLAIM_LENGTH` below. `route.ts`
 * logs them under `aud_unverified`/`iss_unverified`, not `aud`/`iss`, so a
 * forged rejection line can never be mistaken for evidence of the real
 * audience.
 *
 * On the `identity_mismatch` branch, by contrast, `verifyIdToken` has
 * already succeeded — signature, audience, expiry, and issuer are all
 * verified by the time this branch runs. Its `aud`/`iss` (and the
 * classified rejected identity / `email_verified` state) come straight
 * from that verified payload and are logged under their real, trusted
 * names in `route.ts` — this is Google correctly asserting "someone else
 * sent this," not an unverified claim from an unauthenticated caller.
 *
 * Only the success-path log and the `identity_mismatch` log are
 * authoritative; the `token_verification_failed`/`token_payload_missing`
 * failure-path claims never are.
 */

/**
 * The classic Chat-API interaction-events console's own service-account
 * address. Kept as a named historical reference for the module doc and
 * tests only — NEVER used in the acceptance check below. See "Service-
 * account identity" above for why accepting it here would be wrong.
 */
export const CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL = 'chat@system.gserviceaccount.com';

const CHAT_EVENTS_PATH = '/api/chat/events';

const CHAT_PROJECT_NUMBER_ENV_KEY = 'CHAT_PROJECT_NUMBER';

const CHAT_EVENTS_SERVICE_ACCOUNT_ENV_KEY = 'CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL';

/**
 * The expected add-on service-agent identity, or `undefined` when nothing is
 * configured (callers MUST then reject — fail closed).
 *
 * Google's standard per-project service-agent address for the `gsuiteaddons`
 * API is `service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`
 * — see "Service-account identity" in the module doc above for why this, and
 * not `CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL`, is the expected identity for an
 * add-on registration. The project number comes from `CHAT_PROJECT_NUMBER`
 * (never hardcoded: it identifies the operator's own GCP project);
 * `CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL` overrides the derived address if real
 * traffic disproves it. Nothing else should read the number directly.
 */
function resolveExpectedServiceAccountEmail(): string | undefined {
  const configured = process.env[CHAT_EVENTS_SERVICE_ACCOUNT_ENV_KEY];
  if (configured && configured.trim()) return configured.trim();
  const projectNumber = process.env[CHAT_PROJECT_NUMBER_ENV_KEY]?.trim();
  if (projectNumber) {
    return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
  }
  return undefined;
}

/**
 * Default-constructed — no custom `issuers` or `endpoints`. Google's
 * "HTTP endpoint URL" audience configuration issues a normal OIDC ID token
 * (`iss: https://accounts.google.com`), verifiable with Google's ordinary
 * federated OIDC certs. Exported for tests only.
 */
export const chatOAuthClient = new OAuth2Client();

export interface ChatEventAuthResult {
  ok: boolean;
  /** Log-only. Never put this in an HTTP response — it can leak which check failed to an unauthenticated caller. */
  reason?: string;
  /**
   * Log-only diagnostic — the token's `aud` claim. Verified (trustworthy)
   * on `ok: true` AND on the `identity_mismatch` branch, since
   * `verifyIdToken` has already succeeded by the time either is reached.
   * Best-effort decoded and capped at `MAX_UNVERIFIED_CLAIM_LENGTH` chars
   * (attacker-controlled, NOT trustworthy) on the
   * `token_verification_failed` / `token_payload_missing` branches, where
   * verification did not complete.
   */
  aud?: string;
  /** Log-only diagnostic — the token's `iss` claim, same trust rule as `aud` above. */
  iss?: string;
  /** Log-only diagnostic — the token's `email` claim. Only ever set on `ok: true` (i.e. cryptographically verified AND matching the expected service-account identity). */
  email?: string;
  /**
   * Log-only diagnostic, set ONLY on the `identity_mismatch` branch: a
   * privacy-safe classification of the rejected `email` claim (see
   * `classifyRejectedIdentity` below). Never the raw address of a real
   * person — only a verified Google/Workspace service-account address is
   * ever logged verbatim, everything else is hashed or replaced with a
   * fixed literal.
   */
  rejectedIdentity?: string;
  /**
   * Log-only diagnostic, set ONLY on the `identity_mismatch` branch:
   * `payload.email_verified` normalized to `'true'` / `'false'` /
   * `'absent'`. This is what separates "wrong address" from "missing
   * claim" — the two causes that currently produce an identical rejection.
   */
  emailVerifiedState?: 'true' | 'false' | 'absent';
}

function resolveExpectedAudience(): string {
  const configured = process.env['CHAT_EVENTS_AUDIENCE'];
  if (configured && configured.trim()) return configured.trim();
  const appUrl = process.env['ARBITRA_URL'];
  if (appUrl && appUrl.trim()) {
    return `${appUrl.trim().replace(/\/+$/, '')}${CHAT_EVENTS_PATH}`;
  }
  // No audience resolves to a value nothing will ever match, i.e. fail
  // closed — better than guessing a default that might accept the wrong
  // caller.
  return '';
}

/**
 * Cap on `aud`/`iss` claims decoded by `decodeUnverifiedClaims` below. A
 * caller fully controls these values on a public, unauthenticated route —
 * without a cap, a token with e.g. a 4000-char `iss` gets logged verbatim
 * on every rejection. Applied at decode time (not just at the log call
 * site) so nothing downstream of this function can forget to cap it.
 */
const MAX_UNVERIFIED_CLAIM_LENGTH = 64;

/**
 * Cap on a rejected identity logged VERBATIM (the `gserviceaccount.com`
 * branch of `classifyRejectedIdentity` below). Deliberately NOT
 * `MAX_UNVERIFIED_CLAIM_LENGTH`: by the time `classifyRejectedIdentity`
 * runs, `verifyIdToken` has already succeeded, so this is a
 * cryptographically verified, Google-asserted claim, not attacker input —
 * and the expected add-on service-agent address
 * (see `resolveExpectedServiceAccountEmail`) is 63-64 characters, right at
 * the 64-char unverified cap. Reusing that cap here could truncate a
 * correctly-configured caller's own address in its own rejection log
 * (e.g. if `email_verified` were absent), costing a full round trip
 * through a human sending another Chat message just to get an untruncated
 * log line.
 */
const MAX_VERIFIED_IDENTITY_LOG_LENGTH = 128;

const GOOGLE_SERVICE_ACCOUNT_DOMAIN = 'gserviceaccount.com';
const GOOGLE_SERVICE_ACCOUNT_DOMAIN_SUFFIX = `.${GOOGLE_SERVICE_ACCOUNT_DOMAIN}`;

/**
 * Classifies a rejected `email` claim for SAFE logging on the
 * `identity_mismatch` branch.
 *
 * Any person can obtain a Google ID token audienced at a public URL, and
 * Google will assert their real address with `email_verified: true` — so
 * a real person's address must never reach the logs. Classification is on
 * the PARSED domain (the substring after the last `@`), not a substring
 * match anywhere in the address:
 *
 *   - domain === `gserviceaccount.com`, or ends with
 *     `.gserviceaccount.com` (leading dot) → a genuine Google/Workspace
 *     service-account address; log it verbatim, capped at
 *     `MAX_VERIFIED_IDENTITY_LOG_LENGTH`.
 *   - anything else → log a stable, non-reversible discriminator (a
 *     truncated SHA-256 of the lowercased address) — distinguishes repeat
 *     callers without ever revealing the address.
 *   - missing/empty/malformed `email` → a fixed literal.
 *
 * Anchoring on the parsed domain (rather than e.g. `.includes(...)`) is
 * what sends `foo@evil-gserviceaccount.com` (domain
 * `evil-gserviceaccount.com` — does not end with the required leading
 * dot) and `foo@x.gserviceaccount.com.attacker.test` (domain
 * `x.gserviceaccount.com.attacker.test` — ends with `.attacker.test`, not
 * `.gserviceaccount.com`) to the hash branch instead of being logged
 * verbatim.
 */
function classifyRejectedIdentity(email: unknown): string {
  // `email` is typed `string | undefined` upstream, but it comes off a JWT
  // payload: a non-string here must degrade to a literal rather than throw.
  // This branch is on the rejection path of a route Google retries on 5xx,
  // so an exception would turn a clean 401 into a retried 500.
  if (typeof email !== 'string' || !email) return 'no_email_claim';
  // Exactly one `@`. Parsing the domain from the LAST one would log
  // `jane.doe@gmail.com@gserviceaccount.com` verbatim — unreachable through
  // Google-signed traffic, but the check costs nothing and the failure mode
  // is a real address in the logs.
  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex === email.length - 1) return 'malformed_email_claim';
  if (email.indexOf('@', atIndex + 1) !== -1) return 'malformed_email_claim';
  const domain = email.slice(atIndex + 1).toLowerCase();
  if (domain === GOOGLE_SERVICE_ACCOUNT_DOMAIN || domain.endsWith(GOOGLE_SERVICE_ACCOUNT_DOMAIN_SUFFIX)) {
    return email.slice(0, MAX_VERIFIED_IDENTITY_LOG_LENGTH);
  }
  const digest = nodeCrypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
  return `sha256:${digest}`;
}

/** Normalizes `payload.email_verified` (a `boolean | undefined` claim, never personal data) for logging. */
function normalizeEmailVerifiedState(value: boolean | undefined): 'true' | 'false' | 'absent' {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'absent';
}

/**
 * Best-effort, UNVERIFIED decode of a JWT's payload segment. Used only to
 * report which `aud`/`iss` a caller actually sent when verification fails
 * before completing (`token_verification_failed` / `token_payload_missing`
 * below). This is NOT a verification step and its output must never be
 * used for auth decisions — an attacker can put any string here, including
 * `https://accounts.google.com` itself with a forged `aud`, so it must
 * never be presented as evidence of what the real audience is. See the
 * `aud_unverified`/`iss_unverified` naming at the `route.ts` call site.
 */
function decodeUnverifiedClaims(token: string): { aud?: string; iss?: string } | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1] ?? '', 'base64').toString('utf-8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      aud: typeof record['aud'] === 'string' ? record['aud'].slice(0, MAX_UNVERIFIED_CLAIM_LENGTH) : undefined,
      iss: typeof record['iss'] === 'string' ? record['iss'].slice(0, MAX_UNVERIFIED_CLAIM_LENGTH) : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function verifyChatEventToken(
  request: Request,
  client: OAuth2Client = chatOAuthClient,
): Promise<ChatEventAuthResult> {
  const expectedAudience = resolveExpectedAudience();

  const authHeader = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (!authHeader) {
    return { ok: false, reason: 'no_authorization_header' };
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    return { ok: false, reason: 'malformed_bearer' };
  }
  const token = (match[1] ?? '').trim();
  if (!token) {
    return { ok: false, reason: 'empty_bearer_token' };
  }

  const unverifiedClaims = decodeUnverifiedClaims(token);

  // Fail closed when the expected identity is not configured: no
  // `CHAT_PROJECT_NUMBER` and no `CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL` means
  // nothing can match, so reject before spending a certs fetch on it.
  const expectedEmail = resolveExpectedServiceAccountEmail();
  if (!expectedEmail) {
    return { ok: false, reason: 'chat_project_not_configured' };
  }

  let payload;
  try {
    // Signature, issuer (Google's own default allow-list — see the module
    // doc above for why that is correct for THIS token shape), audience,
    // and expiry are all enforced inside this one call.
    const ticket = await client.verifyIdToken({ idToken: token, audience: expectedAudience });
    payload = ticket.getPayload();
  } catch (_err) {
    return {
      ok: false,
      reason: 'token_verification_failed',
      aud: unverifiedClaims?.aud,
      iss: unverifiedClaims?.iss,
    };
  }

  if (!payload) {
    return {
      ok: false,
      reason: 'token_payload_missing',
      aud: unverifiedClaims?.aud,
      iss: unverifiedClaims?.iss,
    };
  }

  // The check `verifyIdToken` above does NOT make on its own: `iss:
  // https://accounts.google.com` alone is satisfied by an enormous number
  // of unrelated Google-issued ID tokens (anything requested with
  // `audience` set to our URL). This is what narrows "signed by Google"
  // down to "asserted by the expected service account specifically" — the
  // whole difference between this gate and a much weaker one. Both
  // conditions come from the doc's own verification sample for this token
  // shape (see module doc above); the expected VALUE comes from
  // `resolveExpectedServiceAccountEmail` (see "Service-account identity"
  // in the module doc for why it is the add-on agent, not
  // `CLASSIC_CHAT_SERVICE_ACCOUNT_EMAIL`).
  //
  // By this point `verifyIdToken` has already succeeded — signature,
  // audience, expiry, and issuer are all verified — so `payload.aud` /
  // `payload.iss` / `payload.email` / `payload.email_verified` below are
  // Google-asserted, not attacker-controlled, and are safe to log under
  // their real names (see `route.ts`).
  if (payload.email !== expectedEmail || payload.email_verified !== true) {
    return {
      ok: false,
      reason: 'identity_mismatch',
      aud: payload.aud,
      iss: payload.iss,
      rejectedIdentity: classifyRejectedIdentity(payload.email),
      emailVerifiedState: normalizeEmailVerifiedState(payload.email_verified),
    };
  }

  return { ok: true, aud: payload.aud, iss: payload.iss, email: payload.email };
}
