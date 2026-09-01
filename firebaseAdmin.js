import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Service account JSON (as a single-line string) from Firebase Console >
// Project Settings > Service Accounts > Generate new private key. Needed by
// the payment flow (marks a user "approved" in Firestore after a confirmed
// Bakong payment) and the password-reset flow (actually changes a user's
// password after a verified code) — the client can't be trusted to do
// either of those to itself. Every other endpoint works without it.
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

export const firebaseAdminReady = Boolean(serviceAccountJson);

// firebase-admin v14 dropped the old monolithic `admin.auth()` /
// `admin.firestore()` / `admin.credential` namespace object in favor of
// these modular subpath imports (`firebase-admin/app`, `/firestore`,
// `/auth`) — the old style silently returns undefined instead of throwing,
// so this was broken from the start and only surfaced once
// FIREBASE_SERVICE_ACCOUNT_JSON was actually set (before that,
// firebaseAdminReady being false short-circuited past all of this).
if (firebaseAdminReady && !getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(serviceAccountJson)),
  });
}

export const adminDb = firebaseAdminReady ? getFirestore() : null;
// Exported (not just the verifyIdToken wrapper below) so passwordReset.js
// can call getUserByEmail()/updateUser() — changing another account's
// password can only ever happen via the Admin SDK or Firebase's own
// link-based reset flow, never directly from the browser.
export const adminAuth = firebaseAdminReady ? getAuth() : null;

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
