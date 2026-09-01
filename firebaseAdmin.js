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
const adminAuth = firebaseAdminReady ? admin.auth() : null;

// Verifies a Firebase ID token (from an `Authorization: Bearer <token>`
// header) and returns the uid it was actually issued for. Payment routes
// must call this instead of trusting a `uid` field in the request body —
// a plain uid in JSON is just a string anyone can type in, so without this
// check any caller could grant access to (or read payment state for) an
// account that isn't theirs.
export async function verifyIdToken(idToken) {
  if (!adminAuth) throw new Error('Firebase admin not configured');
  const decoded = await adminAuth.verifyIdToken(idToken);
  return decoded.uid;
}
