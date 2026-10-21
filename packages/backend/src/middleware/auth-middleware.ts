import { verifyToken, extractBearerToken } from '../lib/auth.js';
import { UnauthorizedError } from '@arbitra/shared';
import { collections } from '../lib/firestore.js';
import crypto from 'node:crypto';

export interface AuthenticatedRequest {
  userId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  /**
   * Discriminates how the caller authenticated. Used by route handlers to
   * pick the correct `agent_presence` source label (token → ide_agent,
   * firebase → web). Emulator dev-mode is treated as firebase since it
   * stands in for an interactive session.
   */
  authType: 'token' | 'firebase';
}

const DEV_USER: AuthenticatedRequest = {
  userId: 'usr_dev',
  email: 'dev@arbitra.local',
  displayName: 'Dev User',
  authType: 'firebase',
};

/** uids whose profile this process has already written at least once. */
const syncedUsers = new Set<string>();

/**
 * Header-less requests run as DEV_USER only against the Auth emulator and never
 * in a production build, so a stray emulator variable on a deployed instance
 * cannot turn every anonymous request into an authenticated one.
 */
function isEmulatorMode(): boolean {
  return !!process.env['FIREBASE_AUTH_EMULATOR_HOST'] && process.env['NODE_ENV'] !== 'production';
}

/**
 * `ARBITRA_ADMIN_EMAILS` (comma-separated) bootstraps administrators: a listed,
 * verified account gets the admin role on sign-in. Promote-only — removing an
 * address does not demote; use the user management UI for that.
 */
function isBootstrapAdmin(email: string, emailVerified: boolean | undefined): boolean {
  if (!emailVerified) return false;
  const list = process.env['ARBITRA_ADMIN_EMAILS'];
  if (!list) return false;
  const normalized = email.trim().toLowerCase();
  return list.split(',').some((entry) => entry.trim().toLowerCase() === normalized);
}

/** Hash a raw PAT value for comparison with stored hash */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Generate a new PAT: returns { raw, hash, prefix } */
export function generatePAT(): { raw: string; hash: string; prefix: string } {
  const raw = `arb_${crypto.randomBytes(32).toString('hex')}`;
  const hash = hashToken(raw);
  const prefix = `${raw.slice(0, 8)}...${raw.slice(-4)}`;
  return { raw, hash, prefix };
}

async function authenticateWithPAT(token: string): Promise<AuthenticatedRequest | null> {
  if (!token.startsWith('arb_')) return null;

  const hash = hashToken(token);

  try {
    const snapshot = await collections.tokens()
      .where('token_hash', '==', hash)
      .limit(1)
      .get();

    if (snapshot.empty) return null;

    const pat = snapshot.docs[0]!.data();

    // Check expiry
    if (pat.expires_at && new Date(pat.expires_at) < new Date()) {
      return null;
    }

    // Update last_used_at (fire-and-forget)
    collections.tokens().doc(pat.token_id).update({
      last_used_at: new Date().toISOString(),
    }).catch(() => {});

    // Look up user
    const userDoc = await collections.users().doc(pat.user_id).get();
    const email = userDoc.exists ? userDoc.data()!.email : `${pat.user_id}@arbitra.local`;

    return { userId: pat.user_id, email, authType: 'token' };
  } catch {
    return null;
  }
}

export async function authenticateFromHeader(authorizationHeader: string | null): Promise<AuthenticatedRequest> {
  // In emulator mode, allow unauthenticated requests with a dev user
  if (isEmulatorMode() && !authorizationHeader) {
    return DEV_USER;
  }

  const token = extractBearerToken(authorizationHeader);

  // Try PAT auth first (tokens starting with arb_)
  if (token.startsWith('arb_')) {
    const result = await authenticateWithPAT(token);
    if (result) return result;
    throw new UnauthorizedError('Invalid or expired access token');
  }

  // Fall back to Firebase ID token
  const decoded = await verifyToken(token);

  if (!decoded.email) {
    throw new UnauthorizedError('Token does not contain email');
  }

  // Server-side Workspace domain lock (#1062). The frontend's `hd` custom
  // parameter (firebase-client.ts) is advisory only — a crafted OAuth flow
  // can omit it — so this is the actual enforcement. Checked before any
  // Firestore write below: an out-of-domain account must never get a user
  // record created, only rejected. Fail-open (no restriction) when
  // AUTH_HOSTED_DOMAIN is unset, so local dev and the current
  // single-tenant deployment keep working until the var is set per
  // environment.
  const hostedDomain = process.env['AUTH_HOSTED_DOMAIN']?.trim();
  if (hostedDomain) {
    const allowedDomain = hostedDomain.toLowerCase().replace(/\.$/, '');
    const emailDomain = decoded.email.toLowerCase().split('@')[1];
    if (!decoded.email_verified || emailDomain !== allowedDomain) {
      throw new UnauthorizedError('Email domain not allowed');
    }
  }

  const displayName = (decoded.name as string | undefined) ?? undefined;
  const avatarUrl = (decoded.picture as string | undefined) ?? undefined;
  const bootstrapAdmin = isBootstrapAdmin(decoded.email, decoded.email_verified);

  // Sync the user profile to Firestore. The first request of a process for a
  // uid waits for the write, so a new user (or a bootstrap admin) is never
  // answered from a profile that does not exist yet; later requests sync in
  // the background.
  const now = new Date().toISOString();
  const userRef = collections.users().doc(decoded.uid);
  const sync = userRef.get().then((doc) => {
    if (doc.exists) {
      // Update mutable fields only
      const roles: string[] = doc.data()?.roles ?? [];
      return userRef.update({
        email: decoded.email,
        display_name: displayName ?? decoded.email!.split('@')[0] ?? '',
        avatar_url: avatarUrl,
        updated_at: now,
        ...(bootstrapAdmin && !roles.includes('admin') ? { roles: [...roles, 'admin'] } : {}),
      });
    }
    // First login — create full profile
    return userRef.set({
      user_id: decoded.uid,
      email: decoded.email!,
      display_name: displayName ?? decoded.email!.split('@')[0] ?? '',
      avatar_url: avatarUrl,
      roles: bootstrapAdmin ? ['developer', 'admin'] : ['developer'],
      created_at: now,
      updated_at: now,
    } satisfies import('@arbitra/shared').User);
  }).then(() => { syncedUsers.add(decoded.uid); }).catch(() => {});
  if (!syncedUsers.has(decoded.uid)) await sync;

  return {
    userId: decoded.uid,
    email: decoded.email,
    displayName,
    avatarUrl,
    authType: 'firebase',
  };
}
