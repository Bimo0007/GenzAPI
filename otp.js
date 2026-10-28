// Signup email-verification OTP, sent server-side. The browser used to call
// EmailJS directly with the public key, which anyone could copy out of the
// JS bundle and use to drain the monthly quota (or spam other people's
// inboxes). Here the caller must be signed in, the recipient is always the
// signed-in account's own email (never taken from the request), and sends
// are rate-limited per account.
import { randomInt } from 'crypto';
import { adminAuth, adminDb, firebaseAdminReady, verifyIdToken } from './firebaseAdmin.js';

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
// The signup OTP template ({{passcode}}/{{time}}), not the reset-link one.
const EMAILJS_OTP_TEMPLATE_ID = process.env.EMAILJS_OTP_TEMPLATE_ID || process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

const OTP_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 5;

// uid -> send timestamps within the last hour. In-memory, like the other
// short-lived maps in this API; a restart just resets the counters.
const sends = new Map();

function checkRate(uid) {
  const now = Date.now();
  const recent = (sends.get(uid) || []).filter((t) => now - t < HOUR_MS);
  if (recent.length && now - recent[recent.length - 1] < COOLDOWN_MS) {
    return { ok: false, retryAfterMs: COOLDOWN_MS - (now - recent[recent.length - 1]) };
  }
  if (recent.length >= MAX_PER_HOUR) {
    return { ok: false, retryAfterMs: HOUR_MS - (now - recent[0]) };
  }
  recent.push(now);
  sends.set(uid, recent);
  return { ok: true, stamp: now };
}

// A send that EmailJS rejected shouldn't burn the user's cooldown/hourly
// allowance — only emails that actually went out count.
function refundRate(uid, stamp) {
  sends.set(uid, (sends.get(uid) || []).filter((t) => t !== stamp));
}

async function sendOtpEmail({ email, code, expiresAt, name }) {
  const time = new Date(expiresAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Phnom_Penh',
  });
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_OTP_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY || undefined,
      // Same param aliases the old client-side call sent, so the existing
      // EmailJS template keeps working whichever variable names it uses.
      template_params: {
        email,
        to_email: email,
        user_email: email,
        recipient: email,
        reply_to: email,
        passcode: code,
        code,
        otp: code,
        verification_code: code,
        name,
        to_name: name,
        user_name: name,
        time,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`EmailJS ${res.status}: ${body}`);
  }
}

export function registerOtpRoutes(app) {
  app.post('/api/auth/otp/send', async (req, res) => {
    if (!firebaseAdminReady) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.' });
    }
    if (!EMAILJS_SERVICE_ID || !EMAILJS_OTP_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
      return res.status(500).json({ error: 'EmailJS is not configured on the server.' });
    }

    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Sign in required.' });
    }
    let uid;
    try {
      uid = await verifyIdToken(authorization.slice(7));
    } catch {
      return res.status(401).json({ error: 'Invalid session.' });
    }

    try {
      const user = await adminAuth.getUser(uid);
      const email = (user.email || '').toLowerCase();
      if (!email) return res.status(400).json({ error: 'Account has no email.' });

      const profileSnap = await adminDb.collection('users').doc(uid).get();
      const profile = profileSnap.exists ? profileSnap.data() : {};
      if (profile.emailVerified === true) {
        return res.status(400).json({ error: 'Email already verified.', code: 'already_verified' });
      }

      const rate = checkRate(uid);
      if (!rate.ok) {
        res.set('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
        return res.status(429).json({ error: 'Too many codes requested. Please wait and try again.', code: 'rate_limited', retryAfterMs: rate.retryAfterMs });
      }

      const code = String(randomInt(100000, 1000000));
      const expiresAt = Date.now() + OTP_TTL_MS;
      await adminDb.collection('otps').doc(uid).set({ code, email, expiresAt, attempts: 0 });
      try {
        await sendOtpEmail({ email, code, expiresAt, name: profile.name || email.split('@')[0] });
      } catch (sendErr) {
        refundRate(uid, rate.stamp);
        throw sendErr;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('otp/send failed:', err.message || err);
      res.status(502).json({ error: 'Failed to send verification email.' });
    }
  });

  // Checks the typed code server-side. The otps collection is closed to
  // clients in firestore.rules, so the code can't be read from the browser,
  // and only this route (Admin SDK) can flip users/{uid}.emailVerified.
  app.post('/api/auth/otp/verify', async (req, res) => {
    if (!firebaseAdminReady) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.' });
    }
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Sign in required.' });
    }
    let uid;
    try {
      uid = await verifyIdToken(authorization.slice(7));
    } catch {
      return res.status(401).json({ error: 'Invalid session.' });
    }
    const code = String(req.body?.code || '').trim();

    try {
      const ref = adminDb.collection('otps').doc(uid);
      const snap = await ref.get();
      if (!snap.exists) return res.status(400).json({ code: 'invalid_or_expired' });
      const otp = snap.data();
      if (Date.now() > otp.expiresAt) return res.status(400).json({ code: 'expired' });
      if (otp.attempts >= 5) return res.status(400).json({ code: 'too_many_attempts' });
      if (otp.code !== code) {
        await ref.update({ attempts: (otp.attempts || 0) + 1 });
        return res.status(400).json({ code: 'wrong_code' });
      }
      await adminDb.collection('users').doc(uid).update({ emailVerified: true });
      await ref.delete();
      res.json({ ok: true });
    } catch (err) {
      console.error('otp/verify failed:', err.message || err);
      res.status(500).json({ error: 'Verification failed.' });
    }
  });
}
