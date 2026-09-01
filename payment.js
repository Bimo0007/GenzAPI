// Bakong KHQR payment for the Pricing page ($9.99 / first 3 months).
//
// KHQR generation (the `qr` string + its `md5`) happens entirely locally via
// the `bakong-khqr` package — no API call needed for that part. Verifying
// that a payment actually happened DOES need a live call to the National
// Bank of Cambodia's Bakong Open API (check_transaction_by_md5), which
// requires real merchant credentials — see .env.example for how to get them.
//
// IMPORTANT: per Bakong's own docs, check_transaction_by_md5 can only be
// called from servers physically located in Cambodia once BAKONG_API_BASE_URL
// points at production — calls from elsewhere (e.g. Railway's Singapore
// region) are blocked. Confirm this still holds and where your token's
// environment (sandbox vs production) stands before relying on this in
// production; sandbox testing is unaffected.
import pkg from 'bakong-khqr';
import QRCode from 'qrcode';
import { adminDb, firebaseAdminReady, verifyIdToken } from './firebaseAdmin.js';

const { BakongKHQR, khqrData, IndividualInfo } = pkg;

const BAKONG_API_BASE_URL = process.env.BAKONG_API_BASE_URL;
const BAKONG_API_TOKEN = process.env.BAKONG_API_TOKEN;
const BAKONG_ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID;
const BAKONG_MERCHANT_NAME = process.env.BAKONG_MERCHANT_NAME || 'GenZ Trader';
const BAKONG_MERCHANT_CITY = process.env.BAKONG_MERCHANT_CITY || 'Phnom Penh';

const PRICE_USD = 9.99;
const QR_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes to scan and pay
const SUBSCRIPTION_MS = 90 * 24 * 60 * 60 * 1000; // "first 3 months"

const paymentReady = Boolean(BAKONG_API_BASE_URL && BAKONG_API_TOKEN && BAKONG_ACCOUNT_ID);

// md5 -> { uid, createdAt } — pending, not-yet-confirmed payments. In-memory
// only: a server restart just means an in-flight QR needs to be regenerated,
// same as it expiring naturally after QR_EXPIRY_MS.
const pending = new Map();

function buildKhqr(uid) {
  const billNumber = `GZT-${uid.slice(0, 8)}-${Date.now()}`;
  const info = new IndividualInfo(BAKONG_ACCOUNT_ID, BAKONG_MERCHANT_NAME, BAKONG_MERCHANT_CITY, {
    currency: khqrData.currency.usd,
    amount: PRICE_USD,
    billNumber,
    storeLabel: BAKONG_MERCHANT_NAME,
    terminalLabel: 'Web',
    expirationTimestamp: Date.now() + QR_EXPIRY_MS,
  });
  const khqr = new BakongKHQR();
  const result = khqr.generateIndividual(info);
  if (result.status.code !== 0) {
    throw new Error(result.status.message || 'KHQR generation failed');
  }
  return result.data; // { qr, md5 }
}

async function checkBakongTransaction(md5) {
  const res = await fetch(`${BAKONG_API_BASE_URL}/v1/check_transaction_by_md5`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BAKONG_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ md5 }),
  });
  return res.json();
}

// Marks the user approved and records when this intro period ends. Nothing
// currently reads subscriptionExpiresAt to auto-revoke access when it
// passes — that would need a scheduled job, which is a deliberate "not yet"
// for this first version. It's there for admins to see in Firestore.
async function grantAccess(uid) {
  const paidAt = Date.now();
  const expiresAt = paidAt + SUBSCRIPTION_MS;
  await adminDb.collection('users').doc(uid).update({
    status: 'approved',
    paidAt,
    subscriptionExpiresAt: expiresAt,
  });
  return expiresAt;
}

// Pulls the caller's uid out of a verified Firebase ID token instead of
// trusting a `uid` field in the request body — a bare uid in JSON is just a
// string anyone can type in, so without this a caller could grant/check
// payment access for an account that isn't theirs. Sends the 401 response
// itself on failure; callers should return immediately when this resolves
// to null.
async function requireUid(req, res) {
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'Missing Authorization bearer token.' });
    return null;
  }
  try {
    return await verifyIdToken(idToken);
  } catch {
    res.status(401).json({ error: 'Invalid or expired auth token.' });
    return null;
  }
}

export function registerPaymentRoutes(app) {
  // Honor-system grant for the static ABA PayWay link on the Pricing page:
  // called the moment the user clicks "Pay", with NO verification that a
  // payment actually happened (that link isn't generated per-transaction,
  // so there's nothing to check against). That trade-off is still
  // deliberate and known — revisit if abuse shows up — but requireUid()
  // at least confines it to the caller's own account: a signed-in user can
  // grant themselves early access, but can no longer grant it to (or read
  // payment state for) an account that isn't theirs.
  app.post('/api/payment/claim', async (req, res) => {
    if (!firebaseAdminReady) {
      return res
        .status(500)
        .json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured — cannot grant access.' });
    }
    const uid = await requireUid(req, res);
    if (!uid) return;

    try {
      const expiresAt = await grantAccess(uid);
      res.json({ approved: true, expiresAt });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: 'Failed to grant access.' });
    }
  });

  app.post('/api/payment/create', async (req, res) => {
    if (!paymentReady) {
      return res.status(500).json({ error: 'Bakong payment is not configured on the server yet.' });
    }
    const uid = await requireUid(req, res);
    if (!uid) return;

    try {
      const { qr, md5 } = buildKhqr(uid);
      const qrImage = await QRCode.toDataURL(qr);
      pending.set(md5, { uid, createdAt: Date.now() });
      res.json({ md5, qrImage, price: PRICE_USD, currency: 'USD', expiresInMs: QR_EXPIRY_MS });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: 'Failed to generate KHQR code.' });
    }
  });

  app.post('/api/payment/check', async (req, res) => {
    if (!paymentReady) {
      return res.status(500).json({ error: 'Bakong payment is not configured on the server yet.' });
    }
    if (!firebaseAdminReady) {
      return res
        .status(500)
        .json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured — cannot grant access after payment.' });
    }
    const uid = await requireUid(req, res);
    if (!uid) return;
    const { md5 } = req.body || {};
    const record = pending.get(md5);
    if (!record || record.uid !== uid) {
      return res.status(404).json({ error: 'Unknown or expired payment session.' });
    }

    try {
      const result = await checkBakongTransaction(md5);
      if (result.responseCode === 0 && result.data) {
        if (result.data.toAccountId !== BAKONG_ACCOUNT_ID) {
          return res.status(409).json({ error: 'Payment recipient mismatch.' });
        }
        const expiresAt = await grantAccess(record.uid);
        pending.delete(md5);
        return res.json({ paid: true, expiresAt });
      }
      res.json({ paid: false });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: 'Failed to check payment status.' });
    }
  });
}
