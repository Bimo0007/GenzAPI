// Always-on background AI signal scanner. Runs inside the server process (Railway), so signals
// are produced whether or not anyone has the site open.
//
// Every tick (default 60s) it checks each pair for a newly CLOSED M15 candle. Each new candle is
// analysed once; a trade signal (never "hold") is published to the site feed, pushed to member
// devices and (optionally) sent to Telegram. It only publishes signals — it never places orders.
// Orders still require the owner's confirm click on the trade desk.
//
// Safe against restarts and double deployments: each (pair, candle) is claimed with an atomic
// Firestore create, so only one instance analyses and publishes it.

import { getMessaging } from 'firebase-admin/messaging';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, firebaseAdminReady } from '../firebaseAdmin.js';
import * as oanda from './oanda.js';
import { produceSignal, storePendingSignal, LIMITS } from './routes.js';

const STATE = () => adminDb.collection('aiScannerState');
const dayKey = () => new Date().toISOString().slice(0, 10);
const num = (name, fb) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fb; };

const CFG = () => ({
  intervalMs: num('AI_SCAN_INTERVAL_SEC', 60) * 1000,
  pairs: String(process.env.AI_SCAN_PAIRS || 'XAUUSD').split(',').map((p) => p.trim().toUpperCase()).filter((p) => oanda.TRADING_PAIRS[p]),
  cooldownMs: num('AI_SIGNAL_COOLDOWN_MIN', 60) * 60 * 1000,
  maxPerDay: num('AI_MAX_SIGNALS_PER_DAY', 6),
  signalTtlSec: num('AI_SCANNER_SIGNAL_TTL_MIN', 15) * 60,
});

let started = false;

export function scannerEnabled() {
  const flag = String(process.env.AI_SCANNER_ENABLED ?? 'true').toLowerCase();
  return flag !== 'false' && flag !== '0';
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
const fmtPrice = (n, d) => Number(n).toFixed(d);

function describe(pair, signal, precision) {
  return {
    title: `AI Signal: ${pair} ${signal.direction.toUpperCase()}`,
    body: `Entry ${fmtPrice(signal.entry, precision)} · SL ${fmtPrice(signal.stopLoss, precision)} · TP ${fmtPrice(signal.takeProfit, precision)} · R:R 1:${signal.riskReward} · ${signal.confidence}% confidence`,
  };
}

async function publishToFeed(pair, signal, precision) {
  if (pair !== 'XAUUSD') return null; // the site's signal board is Gold-only
  const id = `AI-${pair}-${Date.now()}`;
  await adminDb.collection('signals').doc(id).set({
    pair, symbol: pair, direction: signal.direction.toUpperCase(),
    entry: signal.entry, sl: signal.stopLoss, tp: signal.takeProfit, rr: signal.riskReward,
    confidence: signal.confidence, reason: signal.reason, confluences: [signal.reason],
    timeframe: 'M15', style: 'daytrade', status: 'active',
    source: 'PIP AI BACKGROUND SCANNER', isRealData: true, isRealAiGenerated: true,
    createdAt: FieldValue.serverTimestamp(), publishedAt: Date.now(),
  });
  return id;
}

async function pushToDevices(pair, signal, precision) {
  const tokenSnap = await adminDb.collectionGroup('notificationTokens').get();
  const profiles = new Map();
  const targets = new Map();
  await Promise.all(tokenSnap.docs.map(async (d) => {
    const uid = d.ref.parent.parent?.id;
    const token = d.data().token;
    if (!uid || !token) return;
    if (!profiles.has(uid)) profiles.set(uid, adminDb.collection('users').doc(uid).get());
    const p = await profiles.get(uid);
    if (!p.exists) return;
    const prof = p.data();
    const staff = prof.role === 'admin' || prof.role === 'dev';
    const paid = [prof.plan, prof.tier, prof.subscription, prof.membership]
      .some((v) => typeof v === 'string' && /starter|pro|elite|vip/i.test(v));
    if (staff || paid) targets.set(token, d.ref);
  }));
  const entries = [...targets.entries()];
  if (!entries.length) return 0;
  const { title, body } = describe(pair, signal, precision);
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const result = await getMessaging().sendEachForMulticast({
      tokens: batch.map(([t]) => t),
      notification: { title, body },
      webpush: { notification: { tag: `ai-signal-${pair}`, renotify: true } },
    });
    await Promise.all(result.responses.map((r, idx) => {
      const code = r.error?.code;
      return !r.success && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')
        ? batch[idx][1].delete() : null;
    }));
  }
  return entries.length;
}

async function sendTelegram(pair, signal, precision) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = [
    `<b>${esc(pair)} ${signal.direction.toUpperCase()}</b>  ·  ${signal.confidence}% confidence`,
    `Entry: <code>${fmtPrice(signal.entry, precision)}</code>`,
    `Stop-loss: <code>${fmtPrice(signal.stopLoss, precision)}</code>`,
    `Take-profit: <code>${fmtPrice(signal.takeProfit, precision)}</code>`,
    `Risk:Reward 1:${signal.riskReward}`,
    '',
    esc(signal.reason),
  ].join('\n');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return res.ok;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Scan logic
// ---------------------------------------------------------------------------
async function newestClosedM15(instrument) {
  const candles = await oanda.getCandles(instrument, 'M15', 2);
  return candles.length ? candles[candles.length - 1].time : null;
}

async function scanPair(pair, cfg, state) {
  const instrument = oanda.TRADING_PAIRS[pair];
  const ps = (state.pairs[pair] ||= {});
  if (ps.pausedUntil && Date.now() < ps.pausedUntil) return;

  const candleTime = await newestClosedM15(instrument);
  if (!candleTime || candleTime === ps.lastCandleTime) return; // nothing new since last analysis

  // Claim this candle atomically so a second instance (deploy overlap) skips it.
  try {
    await STATE().doc(`claim_${pair}_${candleTime}`).create({ at: Date.now() });
  } catch (err) {
    if (err?.code === 6 || /ALREADY_EXISTS/i.test(String(err?.message))) { ps.lastCandleTime = candleTime; return; }
    throw err;
  }
  ps.lastCandleTime = candleTime;
  ps.lastAnalysisAt = Date.now();

  const today = dayKey();
  if (ps.dayKey !== today) { ps.dayKey = today; ps.signalsToday = 0; }

  let result;
  try {
    result = await produceSignal(pair, instrument);
  } catch (err) {
    if (err?.status === 429) { ps.pausedUntil = Date.now() + (err.retryAfter || 60) * 1000; ps.lastResult = 'ai-rate-limited'; ps.lastReason = err.message; return; }
    throw err;
  }
  const { signal, atr15, precision } = result;
  ps.lastResult = signal.direction;
  ps.lastReason = signal.reason;
  ps.lastConfidence = signal.confidence;
  if (signal.direction === 'hold') return;

  if (ps.signalsToday >= cfg.maxPerDay) { ps.lastResult = 'skipped-daily-cap'; return; }
  if (ps.lastSignalDirection === signal.direction && Date.now() - (ps.lastSignalAt || 0) < cfg.cooldownMs) { ps.lastResult = 'skipped-cooldown'; return; }

  // Skip when an active signal in the same direction already sits within ~1 ATR of this entry.
  const activeSnap = await adminDb.collection('signals').where('pair', '==', pair).where('status', '==', 'active').get();
  const recent = Date.now() - 12 * 60 * 60 * 1000;
  const nearDuplicate = activeSnap.docs.some((d) => {
    const e = d.data();
    return String(e.direction || '').toLowerCase() === signal.direction
      && Number(e.publishedAt || 0) > recent
      && Math.abs(Number(e.entry) - signal.entry) <= atr15;
  });
  if (nearDuplicate) { ps.lastResult = 'skipped-duplicate-level'; return; }

  const { signalId } = await storePendingSignal({ uid: 'scanner', pair, instrument, signal, atr15, ttlSec: cfg.signalTtlSec, source: 'scanner' });
  ps.lastSignalAt = Date.now();
  ps.lastSignalDirection = signal.direction;
  ps.lastSignalId = signalId;
  ps.signalsToday += 1;

  // Delivery channels are independent: one failing must not hide the signal from the others.
  const outcomes = await Promise.allSettled([
    publishToFeed(pair, signal, precision),
    pushToDevices(pair, signal, precision),
    sendTelegram(pair, signal, precision),
  ]);
  const names = ['feed', 'push', 'telegram'];
  ps.delivery = Object.fromEntries(outcomes.map((o, i) => [names[i], o.status === 'fulfilled' ? (o.value ? 'ok' : 'skipped') : `failed: ${String(o.reason?.message || o.reason).slice(0, 120)}`]));
  console.log(`[AI Scanner] ${pair} ${signal.direction.toUpperCase()} @ ${signal.entry} SL ${signal.stopLoss} TP ${signal.takeProfit} (${signal.confidence}%)`, ps.delivery);
}

export function startAiScanner() {
  if (started) return () => {};
  if (!scannerEnabled()) { console.log('[AI Scanner] Disabled by AI_SCANNER_ENABLED.'); return () => {}; }
  const missing = [];
  if (!firebaseAdminReady) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!oanda.oandaReady()) missing.push('OANDA_API_KEY/OANDA_ACCOUNT_ID');
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (missing.length) { console.warn(`[AI Scanner] Not started, missing: ${missing.join(', ')}`); return () => {}; }
  started = true;

  const cfg = CFG();
  const state = { startedAt: Date.now(), pairs: {}, consecutiveErrors: 0 };
  let running = false;
  let runningSince = 0;
  let stopped = false;

  const persist = () => STATE().doc('main').set({
    startedAt: state.startedAt, lastTickAt: Date.now(), lastError: state.lastError || null,
    lastErrorAt: state.lastErrorAt || null, consecutiveErrors: state.consecutiveErrors,
    pairs: state.pairs, intervalSec: cfg.intervalMs / 1000, minConfidence: LIMITS.minConfidence,
  }, { merge: true }).catch((e) => console.warn('[AI Scanner] Could not save heartbeat:', e.message));

  const tick = async () => {
    // Watchdog: a tick hung on a dead network call must not freeze the scanner forever.
    if (running && Date.now() - runningSince < 5 * 60 * 1000) return;
    running = true;
    runningSince = Date.now();
    try {
      for (const pair of cfg.pairs) {
        try {
          await scanPair(pair, cfg, state);
          state.consecutiveErrors = 0;
          state.lastError = null;
        } catch (err) {
          state.consecutiveErrors += 1;
          state.lastError = `${pair}: ${String(err?.message || err).slice(0, 200)}`;
          state.lastErrorAt = Date.now();
          console.error(`[AI Scanner] ${pair} scan failed (${state.consecutiveErrors}):`, err?.message || err);
        }
      }
    } finally {
      running = false;
      await persist();
    }
  };

  // Restore per-pair memory so a restart doesn't re-announce the same setup.
  STATE().doc('main').get().then((snap) => {
    if (snap.exists && snap.data().pairs) state.pairs = snap.data().pairs;
  }).catch(() => {}).finally(() => {
    if (stopped) return;
    console.log(`[AI Scanner] Running for ${cfg.pairs.join(', ')} every ${cfg.intervalMs / 1000}s.`);
    const first = setTimeout(tick, 5000);
    first.unref?.();
  });

  const timer = setInterval(() => { if (!stopped) tick(); }, cfg.intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
