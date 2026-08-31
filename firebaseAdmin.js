import admin from 'firebase-admin';

// Service account JSON (as a single-line string) from Firebase Console >
// Project Settings > Service Accounts > Generate new private key. Only the
// payment flow needs this — it's how the backend marks a user "approved" in
// Firestore after a confirmed Bakong payment, since the client can't be
// trusted to grant itself access. Every other endpoint works without it.
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

export const firebaseAdminReady = Boolean(serviceAccountJson);

if (firebaseAdminReady && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
  });
}

export const adminDb = firebaseAdminReady ? admin.firestore() : null;
