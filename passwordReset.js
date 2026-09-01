// In-app "forgot password" via a 6-digit code — the user never leaves the
// app or clicks an email link. Mirrors the OTP pattern already used for
// signup email verification (genztrader-react/src/data/auth.js's
// issueOtp), but server-side: at this point the client isn't signed in, so
// it can't write its own OTP doc under Firestore's rules, and actually
// changing another account's password can only ever happen through the
// Admin SDK (or Firebase's own oobCode reset flow, which is link-based) —
// never directly from the browser.
import { adminAuth, firebaseAdminReady } from './firebaseAdmin.js';

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
// Only needed if this EmailJS account has "strict mode" (API calls
// restricted to browser origins) turned on — leave unset otherwise.
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

const emailReady = Boolean(EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY);

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

// email (lowercased) -> { code, expiresAt, attempts, uid }. In-memory only,
// same trade-off as payment.js's `pending` map — short-lived by design, so
// a server restart just means an in-flight code needs to be requested again.
const pending = new Map();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendCodeEmail(email, code) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY || undefined,
      template_params: {
        email,
        passcode: code,
        time: new Date(Date.now() + CODE_TTL_MS).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`EmailJS ${res.status}: ${body}`);
  }
}

export function registerPasswordResetRoutes(app) {
  // Always responds { ok: true } regardless of whether the email actually
  // has an account — a different response for "no such account" would turn
  // this into an email-enumeration oracle (anyone could probe which emails
  // are registered on the site).
  app.post('/api/auth/password-reset/request', async (req, res) => {
    if (!firebaseAdminReady) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.' });
    }
    if (!emailReady) {
      return res.status(500).json({ error: 'EmailJS is not configured on the server.' });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    try {
      const userRecord = await adminAuth.getUserByEmail(email);
      const code = generateCode();
      pending.set(email, { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, uid: userRecord.uid });
      await sendCodeEmail(email, code);
    } catch {
      // No account with this email, or the send failed — deliberately
      // silent (see the enumeration note above); the confirm step below
      // will just report "invalid or expired code" either way.
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/password-reset/confirm', async (req, res) => {
    if (!firebaseAdminReady) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.' });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    // `code` field lets the frontend show its own localized message instead
    // of this hardcoded English text — see confirmPasswordResetCode() in
    // genztrader-react's data/auth.js.
    const entry = pending.get(email);
    if (!entry) {
      return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.', code: 'invalid_or_expired' });
    }
    if (Date.now() > entry.expiresAt) {
      pending.delete(email);
      return res.status(400).json({ error: 'Code expired. Please request a new one.', code: 'expired' });
    }
    if (entry.attempts >= MAX_ATTEMPTS) {
      pending.delete(email);
      return res.status(400).json({ error: 'Too many attempts. Please request a new code.', code: 'too_many_attempts' });
    }
    if (entry.code !== code) {
      entry.attempts += 1;
      return res.status(400).json({ error: 'Incorrect code.', code: 'wrong_code' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.', code: 'weak_password' });
    }

    try {
      await adminAuth.updateUser(entry.uid, { password: newPassword });
      pending.delete(email);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: 'Failed to update password.' });
    }
  });
}
