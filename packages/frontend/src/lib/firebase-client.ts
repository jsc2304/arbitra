'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env['NEXT_PUBLIC_FIREBASE_API_KEY'],
  authDomain: process.env['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'],
  projectId: process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'],
};

let app: FirebaseApp;
let auth: Auth;

export function getFirebaseClientApp(): FirebaseApp {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0]!;
  } else {
    app = initializeApp(firebaseConfig);
  }
  return app;
}

export function getClientAuth(): Auth {
  if (auth) return auth;
  auth = getAuth(getFirebaseClientApp());
  if (process.env['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST']) {
    connectAuthEmulator(auth, `http://${process.env['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST']}`, { disableWarnings: true });
  }
  return auth;
}

const googleProvider = new GoogleAuthProvider();
// Restricts the Google account picker to the configured Workspace domain.
// This is UX only (a crafted OAuth flow can omit `hd`) — the actual
// enforcement is server-side, in authenticateFromHeader (auth-middleware.ts)
// via AUTH_HOSTED_DOMAIN. Omit the parameter entirely when unset (dev/local
// convenience) rather than passing an empty string, which applies no
// restriction while still looking configured.
const hostedDomain = process.env['NEXT_PUBLIC_AUTH_HOSTED_DOMAIN'];
if (hostedDomain) {
  googleProvider.setCustomParameters({ hd: hostedDomain });
}

export async function signInWithGoogle() {
  return signInWithPopup(getClientAuth(), googleProvider);
}

export async function getIdToken(): Promise<string | null> {
  const a = getClientAuth();
  // If currentUser is already available, use it
  if (a.currentUser) return a.currentUser.getIdToken();
  // Wait for auth state to be resolved (first load after page refresh)
  return new Promise((resolve) => {
    const { onAuthStateChanged } = require('firebase/auth');
    const unsubscribe = onAuthStateChanged(a, (user: import('firebase/auth').User | null) => {
      unsubscribe();
      if (user) {
        user.getIdToken().then(resolve).catch(() => resolve(null));
      } else {
        resolve(null);
      }
    });
  });
}
