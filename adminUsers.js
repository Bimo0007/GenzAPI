// Lets an admin create a brand-new account (with a chosen role/status/tier)
// straight from the Admin Dashboard. This has to go through the Admin SDK,
// not a client-side Firestore write: creating a Firebase Auth user via the
// client SDK signs the browser in AS that new user, kicking the admin out
// of their own session — there's no way around that from the client.
import { adminDb, adminAuth, firebaseAdminReady, verifyIdToken } from './firebaseAdmin.js';

// Verifies the caller's Firebase ID token AND that their own Firestore
// profile has role: 'admin' — without the second check, any signed-in
// user could call this endpoint and create accounts (including other
// admins) for themselves.
async function requireAdminUid(req, res) {
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'Missing Authorization bearer token.' });
    return null;
  }
  let uid;
  try {
    uid = await verifyIdToken(idToken);
  } catch {
    res.status(401).json({ error: 'Invalid or expired auth token.' });
    return null;
  }
  const snap = await adminDb.collection('users').doc(uid).get();
  if (!snap.exists || snap.data().role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return uid;
}

export function registerAdminUserRoutes(app) {
  app.post('/api/admin/create-user', async (req, res) => {
    if (!firebaseAdminReady) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured.' });
    }
    const adminUid = await requireAdminUid(req, res);
    if (!adminUid) return;

    const { name, email, password, role, status, tier } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const finalRole = role === 'admin' ? 'admin' : 'user';
    const finalStatus = status === 'approved' ? 'approved' : 'pending';
    const finalTier = tier === 'vip' ? 'vip' : 'member';

    try {
      const userRecord = await adminAuth.createUser({
        email: normalizedEmail,
        password,
        emailVerified: true,
        displayName: name,
      });

      await adminDb
        .collection('users')
        .doc(userRecord.uid)
        .set({
          name,
          email: normalizedEmail,
          status: finalStatus,
          role: finalRole,
          tier: finalTier,
          emailVerified: true,
          createdAt: Date.now(),
          createdByAdmin: adminUid,
        });

      res.json({ ok: true, uid: userRecord.uid });
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      console.error('create-user failed:', err);
      res.status(500).json({ error: err.message || 'Failed to create user.' });
    }
  });
}
