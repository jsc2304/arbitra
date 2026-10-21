import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';

let app: App;

export function getFirebaseApp(): App {
  if (app) return app;

  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0]!;
    return app;
  }

  const credentialsPath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];

  if (credentialsPath) {
    app = initializeApp({
      credential: cert(credentialsPath),
      projectId: process.env['GOOGLE_CLOUD_PROJECT'],
      storageBucket: process.env['GCS_BUCKET'],
    });
  } else {
    // Emulator or Application Default Credentials
    app = initializeApp({
      projectId: process.env['GOOGLE_CLOUD_PROJECT'] ?? 'demo-arbitra',
      storageBucket: process.env['GCS_BUCKET'],
    });
  }

  return app;
}
