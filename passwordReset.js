// In-app "forgot password" via an emailed link — no Firebase-hosted page,
// no code to type. The link carries a random token; clicking it takes the
// user straight to a New Password + Confirm Password screen. Mirrors the
// OTP pattern already used for signup email verification
// (genztrader-react/src/data/auth.js's issueOtp), but server-side: at this
// point the client isn't signed in, so it can't write its own OTP doc
// under Firestore's rules, and actually changing another account's
// password can only ever happen through the Admin SDK (or Firebase's own
// oobCode reset flow) — never directly from the browser.
import { randomBytes } from 'crypto';
import { adminAuth, firebaseAdminReady } from './firebaseAdmin.js';

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
// EmailJS blocks server-side calls by default ("API calls from non-browser
// applications" must be enabled in the EmailJS dashboard's Security page,
// and even then some accounts require this Private Key as the API access
// token) — see EmailJS dashboard > Account > Security.
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
// Where the reset link should point — the live site, not this API. Takes
// the first origin in FRONTEND_ORIGIN (already used for CORS) since that's
// always the real frontend during normal operation; falls back to the
// production domain if FRONTEND_ORIGIN isn't set for some reason.
const FRONTEND_URL = (process.env.FRONTEND_ORIGIN || 'https://genztradermentorship.org')
  .split(',')[0]
  .trim()
  .replace(/\/$/, '');

const emailReady = Boolean(EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY);

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes — longer than the old 6-digit code's 10, since clicking a link is slower than typing a code that's already on screen
const MAX_ATTEMPTS = 5;

// email (lowercased) -> { token, expiresAt, attempts, uid }. In-memory
// only, same trade-off as payment.js's `pending` map — short-lived by
// design, so a server restart just means an in-flight link needs to be
// requested again.
const pending = new Map();

function generateToken() {
  return randomBytes(24).toString('hex'); // 48 hex chars — not brute-forceable like a 6-digit code, so safe to embed straight in a URL
}

async function sendResetLinkEmail(email, token) {
  const link = `${FRONTEND_URL}/?mode=resetPassword&token=${token}&email=${encodeURIComponent(email)}`;
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
        // Reuses the same template as the signup OTP email (its {{passcode}}
        // slot) — most email clients (Gmail included) auto-linkify a raw
        // URL in the rendered text, so this still shows as a clickable
        // link even though the template wasn't built specifically for one.
        passcode: link,
        time: new Date(Date.now() + TOKEN_TTL_MS).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
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
      const token = generateToken();
      pending.set(email, { token, expiresAt: Date.now() + TOKEN_TTL_MS, attempts: 0, uid: userRecord.uid });
      await sendResetLinkEmail(email, token);
    } catch (err) {
      // Still silent to the CALLER (see the enumeration note above) — but
      // logged server-side so a real send failure (bad EmailJS config,
      // wrong template params, etc.) is visible in Railway's logs instead
      // of vanishing. auth/user-not-found is the expected/silent case.
      if (err.code !== 'auth/user-not-found') {
        console.error('password-reset/request failed for a known account:', err.message || err);
      }
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/password-reset/confirm', async (req, res) => {
    if (!firebaseAdminReady) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.' });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    // `code` field lets the frontend show its own localized message instead
    // of this hardcoded English text — see confirmPasswordResetCode() in
    // genztrader-react's data/auth.js.
    const entry = pending.get(email);
    if (!entry) {
      return res.status(400).json({ error: 'Invalid or expired link. Please request a new one.', code: 'invalid_or_expired' });
    }
    if (Date.now() > entry.expiresAt) {
      pending.delete(email);
      return res.status(400).json({ error: 'Link expired. Please request a new one.', code: 'expired' });
    }
    if (entry.attempts >= MAX_ATTEMPTS) {
      pending.delete(email);
      return res.status(400).json({ error: 'Too many attempts. Please request a new link.', code: 'too_many_attempts' });
    }
    if (entry.token !== token) {
      entry.attempts += 1;
      return res.status(400).json({ error: 'Invalid or expired link. Please request a new one.', code: 'invalid_or_expired' });
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
