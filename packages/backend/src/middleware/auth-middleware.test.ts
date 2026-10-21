/**
 * #1062: Google Workspace domain lock, server-side half.
 *
 * The frontend's `hd` custom parameter (firebase-client.ts) is advisory
 * only — a crafted OAuth flow can omit it — so `authenticateFromHeader`
 * must reject an out-of-domain or unverified email itself, before any
 * Firestore write. These tests pin that behavior and its fail-open default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecodedIdToken } from 'firebase-admin/auth';

const userDocState = { get: vi.fn(), set: vi.fn(), update: vi.fn() };

vi.mock('../lib/firestore.js', () => ({
  collections: {
    users: () => ({
      doc: () => userDocState,
    }),
    tokens: () => ({
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
  },
}));

const verifyTokenMock = vi.fn<[], Promise<DecodedIdToken>>();

vi.mock('../lib/auth.js', () => ({
  verifyToken: (...args: unknown[]) => verifyTokenMock(...(args as [])),
  extractBearerToken: (header: string | null) => {
    if (!header?.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header');
    }
    return header.slice(7);
  },
}));

function decodedToken(overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  return {
    uid: 'usr_1',
    email: 'person@example.com',
    email_verified: true,
    aud: 'test',
    auth_time: 0,
    exp: 0,
    firebase: { identities: {}, sign_in_provider: 'google.com' },
    iat: 0,
    iss: 'test',
    sub: 'usr_1',
    ...overrides,
  } as DecodedIdToken;
}

describe('authenticateFromHeader — AUTH_HOSTED_DOMAIN enforcement', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    userDocState.get.mockResolvedValue({ exists: false });
    userDocState.set.mockResolvedValue(undefined);
    userDocState.update.mockResolvedValue(undefined);
    delete process.env['AUTH_HOSTED_DOMAIN'];
    delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  /**
   * Reverts: the whole `if (hostedDomain) { ... }` block in
   * auth-middleware.ts. Without it, a matching-domain token still passes
   * (no observable difference here) — this test's real purpose is the
   * counterpart below (non-matching domain), which the revert makes fail
   * by *not* throwing.
   */
  it('allows a verified token whose email matches AUTH_HOSTED_DOMAIN', async () => {
    process.env['AUTH_HOSTED_DOMAIN'] = 'example.com';
    verifyTokenMock.mockResolvedValue(decodedToken({ email: 'person@example.com', email_verified: true }));

    const { authenticateFromHeader } = await import('./auth-middleware.js');
    const result = await authenticateFromHeader('Bearer sometoken');

    expect(result.email).toBe('person@example.com');
    expect(result.authType).toBe('firebase');
  });

  /**
   * Reverts: the `emailDomain !== allowedDomain` check (or the whole
   * enforcement block). Without it, an out-of-domain account authenticates
   * successfully instead of getting a 401.
   */
  it('rejects a verified token whose email domain does not match AUTH_HOSTED_DOMAIN', async () => {
    process.env['AUTH_HOSTED_DOMAIN'] = 'example.com';
    verifyTokenMock.mockResolvedValue(decodedToken({ email: 'person@other.com', email_verified: true }));

    const { authenticateFromHeader } = await import('./auth-middleware.js');

    await expect(authenticateFromHeader('Bearer sometoken')).rejects.toMatchObject({
      statusCode: 401,
    });
    // The domain check must run before any Firestore user-record write.
    expect(userDocState.set).not.toHaveBeenCalled();
    expect(userDocState.update).not.toHaveBeenCalled();
  });

  /**
   * Reverts: the `!decoded.email_verified` half of the guard condition.
   * Without it, an in-domain but unverified email (e.g. a crafted OAuth
   * flow claiming the domain without actually owning a verified address)
   * would authenticate successfully.
   */
  it('rejects a token with a matching domain but an unverified email', async () => {
    process.env['AUTH_HOSTED_DOMAIN'] = 'example.com';
    verifyTokenMock.mockResolvedValue(decodedToken({ email: 'person@example.com', email_verified: false }));

    const { authenticateFromHeader } = await import('./auth-middleware.js');

    await expect(authenticateFromHeader('Bearer sometoken')).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(userDocState.set).not.toHaveBeenCalled();
  });

  /**
   * Reverts: dropping the `if (hostedDomain)` guard so the check always
   * runs. Without the guard, an out-of-domain account would be rejected
   * even with AUTH_HOSTED_DOMAIN unset, breaking local dev and the current
   * single-tenant deployment — the documented fail-open default.
   */
  it('allows any verified email when AUTH_HOSTED_DOMAIN is unset', async () => {
    expect(process.env['AUTH_HOSTED_DOMAIN']).toBeUndefined();
    verifyTokenMock.mockResolvedValue(decodedToken({ email: 'person@anywhere.example', email_verified: true }));

    const { authenticateFromHeader } = await import('./auth-middleware.js');
    const result = await authenticateFromHeader('Bearer sometoken');

    expect(result.email).toBe('person@anywhere.example');
  });
});

describe('authenticateFromHeader — emulator bypass and admin bootstrap', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    userDocState.get.mockResolvedValue({ exists: false });
    userDocState.set.mockResolvedValue(undefined);
    userDocState.update.mockResolvedValue(undefined);
    delete process.env['AUTH_HOSTED_DOMAIN'];
    delete process.env['ARBITRA_ADMIN_EMAILS'];
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  /** Reverts: the NODE_ENV guard in isEmulatorMode(). */
  it('never treats a header-less request as the dev user in a production build', async () => {
    process.env['FIREBASE_AUTH_EMULATOR_HOST'] = 'localhost:9099';
    process.env['NODE_ENV'] = 'production';

    const { authenticateFromHeader } = await import('./auth-middleware.js');
    await expect(authenticateFromHeader(null)).rejects.toThrow();
  });

  it('keeps the dev user for header-less requests against the emulator outside production', async () => {
    process.env['FIREBASE_AUTH_EMULATOR_HOST'] = 'localhost:9099';
    process.env['NODE_ENV'] = 'development';

    const { authenticateFromHeader } = await import('./auth-middleware.js');
    const result = await authenticateFromHeader(null);
    expect(result.userId).toBe('usr_dev');
  });

  /** Reverts: the bootstrapAdmin branch of the first-login roles. */
  it('creates a listed, verified account with the admin role', async () => {
    process.env['ARBITRA_ADMIN_EMAILS'] = 'someone@example.com, Admin@Example.com';
    verifyTokenMock.mockResolvedValue(decodedToken({ email: 'admin@example.com', email_verified: true }));

    const { authenticateFromHeader } = await import('./auth-middleware.js');
    await authenticateFromHeader('Bearer sometoken');
    await vi.waitFor(() => expect(userDocState.set).toHaveBeenCalled());
    expect(userDocState.set.mock.calls[0]![0].roles).toEqual(['developer', 'admin']);
  });

  /** Reverts: awaiting the first profile sync per uid. */
  it('has written the new profile before the first request returns', async () => {
    process.env['ARBITRA_ADMIN_EMAILS'] = 'admin@example.com';
    verifyTokenMock.mockResolvedValue(decodedToken({ email: 'admin@example.com', email_verified: true }));

    const { authenticateFromHeader } = await import('./auth-middleware.js');
    await authenticateFromHeader('Bearer sometoken');
    expect(userDocState.set).toHaveBeenCalledTimes(1);
    expect(userDocState.set.mock.calls[0]![0].roles).toEqual(['developer', 'admin']);
  });

  it('does not grant admin to an unverified or unlisted account', async () => {
    process.env['ARBITRA_ADMIN_EMAILS'] = 'admin@example.com';
    verifyTokenMock.mockResolvedValue(decodedToken({ email: 'admin@example.com', email_verified: false }));

    const { authenticateFromHeader } = await import('./auth-middleware.js');
    await authenticateFromHeader('Bearer sometoken');
    await vi.waitFor(() => expect(userDocState.set).toHaveBeenCalled());
    expect(userDocState.set.mock.calls[0]![0].roles).toEqual(['developer']);
  });

  it('promotes an existing listed account that lacks the admin role', async () => {
    process.env['ARBITRA_ADMIN_EMAILS'] = 'admin@example.com';
    userDocState.get.mockResolvedValue({ exists: true, data: () => ({ roles: ['developer'] }) });
    verifyTokenMock.mockResolvedValue(decodedToken({ email: 'admin@example.com', email_verified: true }));

    const { authenticateFromHeader } = await import('./auth-middleware.js');
    await authenticateFromHeader('Bearer sometoken');
    await vi.waitFor(() => expect(userDocState.update).toHaveBeenCalled());
    expect(userDocState.update.mock.calls[0]![0].roles).toEqual(['developer', 'admin']);
  });
});
