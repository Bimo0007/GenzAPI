// TEMPORARY, one-time endpoint to backfill demo trading-journal data for a
// single account (requested directly by the account owner). Uses the Admin
// SDK because src/data/journal.js's Firestore rule only ever allows the
// account itself to read/write its own `users/{uid}/journal/{date}` docs —
// not even an admin, from the client — so this is the only way to bulk-write
// it server-side. Delete this file and its registration in server.js once
// the one-time seed has run; it has no reason to exist afterward.
import { adminDb, adminAuth, firebaseAdminReady } from './firebaseAdmin.js';

const SEED_SECRET = process.env.SEED_SECRET;
const PAIRS = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'BTC/USD', 'US30'];

function dateKey(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function randomEntry() {
  const win = Math.random() < 0.6;
  const pnl = win
    ? Math.round((15 + Math.random() * 260) * 100) / 100
    : -Math.round((10 + Math.random() * 150) * 100) / 100;
  const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)];
  return { pnl, pair, note: '', updatedAt: Date.now() };
}

export function registerJournalSeedRoute(app) {
  app.post('/api/admin/seed-journal', async (req, res) => {
    if (!SEED_SECRET) {
      return res.status(500).json({ error: 'SEED_SECRET is not configured on the server.' });
    }
    if (req.headers['x-seed-secret'] !== SEED_SECRET) {
      return res.status(401).json({ error: 'Invalid seed secret.' });
    }
    if (!firebaseAdminReady) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured.' });
    }
    const { email, startDate, endDate } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required.' });

    try {
      const user = await adminAuth.getUserByEmail(email);
      const journalRef = adminDb.collection('users').doc(user.uid).collection('journal');

      const start = startDate ? new Date(startDate) : new Date(2026, 5, 1); // June 1
      const end = endDate ? new Date(endDate) : new Date();
      end.setHours(0, 0, 0, 0);
      start.setHours(0, 0, 0, 0);

      let written = 0;
      let skippedExisting = 0;
      let batch = adminDb.batch();
      let batchCount = 0;

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (day === 0 || day === 6) continue; // weekdays only
        if (Math.random() < 0.22) continue; // not every trading day has an entry

        const key = dateKey(d);
        const docRef = journalRef.doc(key);
        const existing = await docRef.get();
        if (existing.exists) {
          skippedExisting++;
          continue;
        }

        batch.set(docRef, randomEntry());
        batchCount++;
        written++;

        if (batchCount >= 400) {
          await batch.commit();
          batch = adminDb.batch();
          batchCount = 0;
        }
      }
      if (batchCount > 0) await batch.commit();

      res.json({ ok: true, uid: user.uid, written, skippedExisting });
    } catch (err) {
      console.error('seed-journal failed:', err);
      res.status(500).json({ error: err.message || 'Seed failed.' });
    }
  });
}
