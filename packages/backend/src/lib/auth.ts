import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirebaseApp } from './firebase.js';
import { UnauthorizedError } from '@arbitra/shared';

export async function verifyToken(token: string): Promise<DecodedIdToken> {
  try {
    return await getAuth(getFirebaseApp()).verifyIdToken(token);
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
}

export function extractBearerToken(authorizationHeader: string | null): string {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or invalid Authorization header');
  }
  return authorizationHeader.slice(7);
}
