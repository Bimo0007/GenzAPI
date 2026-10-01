// Lets an admin create a brand-new account (with a chosen role/status/tier)
// straight from the Admin Dashboard. This has to go through the Admin SDK,
// not a client-side Firestore write: creating a Firebase Auth user via the
// client SDK signs the browser in AS that new user, kicking the admin out
// of their own session — there's no way around that from the client.
import { adminDb, adminAuth, firebaseAdminReady, verifyIdToken } from './firebaseAdmin.js';
import { getMessaging } from 'firebase-admin/messaging';
import { startNewsPushWatcher } from './newsPush.js';

// Verifies the caller's Firebase ID token AND that their own Firestore
// profile has role: 'admin' or 'dev' — without the second check, any
// signed-in user could call these endpoints and create/delete accounts
// (including other admins) for themselves. Dev has the same Admin
// Dashboard access as admin (src/pages/AdminDashboard.jsx), so it's
// allowed here too.
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
  const role = snap.exists ? snap.data().role : null;
  if (role !== 'admin' && role !== 'dev') {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return uid;
}

export function registerAdminUserRoutes(app) {
  startNewsPushWatcher();

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
    const finalRole = role === 'admin' || role === 'dev' ? role : 'user';
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

  // Deletes both the Firebase Auth account and its Firestore profile — has
  // to go through the Admin SDK since the client is never allowed to delete
  // arbitrary user docs (firestore.rules: allow delete: if false).
  app.post('/api/admin/delete-user', async (req, res) => {
    if (!firebaseAdminReady) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured.' });
    }
    const adminUid = await requireAdminUid(req, res);
    if (!adminUid) return;

    const { uid } = req.body || {};
    if (!uid) {
      return res.status(400).json({ error: 'uid is required.' });
    }
    if (uid === adminUid) {
      return res.status(400).json({ error: "You can't delete your own account." });
    }

    try {
      await adminAuth.deleteUser(uid).catch((err) => {
        if (err.code !== 'auth/user-not-found') throw err;
      });
      await adminDb.collection('users').doc(uid).delete();
      res.json({ ok: true });
    } catch (err) {
      console.error('delete-user failed:', err);
      res.status(500).json({ error: err.message || 'Failed to delete user.' });
    }
  });

  // Publish a generic signal alert to registered paid-member devices. The
  // requester is authenticated as admin/dev and recipient plans are rechecked
  // server-side, so free users cannot be added by editing the client request.
  app.post('/api/admin/notify-signal', async (req, res) => {
    if (!firebaseAdminReady) {
      return res.status(503).json({ error: 'Firebase Admin is not configured on this API.' });
    }
    const adminUid = await requireAdminUid(req, res);
    if (!adminUid) return;

    const signalId = typeof req.body?.signalId === 'string' ? req.body.signalId.trim() : '';
    if (!signalId || signalId.length > 200 || signalId.includes('/')) {
      return res.status(400).json({ error: 'A valid signalId is required.' });
    }

    try {
      const signalSnap = await adminDb.collection('signals').doc(signalId).get();
      if (!signalSnap.exists) return res.status(404).json({ error: 'Signal was not found.' });

      const tokenSnap = await adminDb.collectionGroup('notificationTokens').get();
      const profileReads = new Map();
      const recipients = [];
      await Promise.all(tokenSnap.docs.map(async (tokenDoc) => {
        const uid = tokenDoc.ref.parent.parent?.id;
        const token = tokenDoc.data().token;
        if (!uid || !token) return;

        let profileRead = profileReads.get(uid);
        if (!profileRead) {
          profileRead = adminDb.collection('users').doc(uid).get();
          profileReads.set(uid, profileRead);
        }
        const profileSnap = await profileRead;
        const profile = profileSnap.exists ? profileSnap.data() : null;
        if (!profile || profile.role === 'admin' || profile.role === 'dev') return;

        const plans = [profile.plan, profile.tier, profile.subscription, profile.membership]
          .filter((value) => typeof value === 'string')
          .map((value) => value.trim().toLowerCase());
        const hasPaidPlan = plans.some((plan) =>
          plan.includes('starter') || plan.includes('pro') || plan.includes('elite') || plan === 'vip'
        );
        if (hasPaidPlan) recipients.push({ token, ref: tokenDoc.ref });
      }));

      let sentCount = 0;
      let failedCount = 0;
      for (let start = 0; start < recipients.length; start += 500) {
        const batch = recipients.slice(start, start + 500);
        const result = await getMessaging().sendEachForMulticast({
          tokens: batch.map((recipient) => recipient.token),
          notification: {
            title: '⚡ New Signal',
            body: 'A new signal structure is in the market. Check it out.',
          },
          data: { url: 'https://genztradermentorship.org/' },
          webpush: {
            notification: {
              icon: 'https://genztradermentorship.org/favicon.png',
              badge: 'https://genztradermentorship.org/favicon.png',
              tag: `signal-${signalId}`,
              renotify: true,
              requireInteraction: true,
            },
            fcmOptions: { link: 'https://genztradermentorship.org/' },
          },
        });

        sentCount += result.successCount;
        failedCount += result.failureCount;
        const removals = [];
        result.responses.forEach((response, index) => {
          const code = response.error?.code;
          if (!response.success && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')) {
            removals.push(batch[index].ref.delete());
          }
        });
        await Promise.all(removals);
      }

      res.json({ ok: true, sentCount, failedCount, registeredCount: recipients.length });
    } catch (err) {
      console.error('notify-signal failed:', err);
      res.status(500).json({ error: 'Failed to send signal push notifications.' });
    }
  });
}
