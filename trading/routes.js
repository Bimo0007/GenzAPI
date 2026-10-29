import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI, Type } from '@google/genai';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, firebaseAdminReady, verifyIdToken } from '../firebaseAdmin.js';
import * as oanda from './oanda.js';
import * as twelveData from './twelvedata.js';
import { summarizeTimeframe, isChoppy } from './indicators.js';
import {
  DEFAULT_LIMITS, validateAiSignal, computePositionUnits, checkExecutionConditions,
  checkAccountLimits, classifyOutcome, pipsBetween,
} from './risk.js';

const { TRADING_PAIRS, OandaError } = oanda;

const envNum = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  ...DEFAULT_LIMITS,
  riskPct: envNum('AI_RISK_PCT', DEFAULT_LIMITS.riskPct),
  maxDailyLossPct: envNum('AI_MAX_DAILY_LOSS_PCT', DEFAULT_LIMITS.maxDailyLossPct),
  maxOpenTrades: envNum('AI_MAX_OPEN_TRADES', DEFAULT_LIMITS.maxOpenTrades),
  minRr: Math.max(2, envNum('AI_MIN_RR', DEFAULT_LIMITS.minRr)), // never below 1:2
  minConfidence: envNum('AI_MIN_CONFIDENCE', DEFAULT_LIMITS.minConfidence),
};

const GEMINI_MODEL = process.env.AI_TRADING_MODEL || 'gemini-2.5-flash';
const genai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

export const SIGNALS = 'aiTradeSignals';
const TRADES = 'aiTrades';
const DAYS = 'aiTradeDays';

const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Auth. Analysis needs a paid plan (or staff). Placing orders moves real money on ONE shared
// broker account, so it is restricted to staff (role admin/dev) only.
// ---------------------------------------------------------------------------
async function getAccess(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Sign in to use AI trading.');
  if (!firebaseAdminReady) throw new HttpError(503, 'AI trading is not configured on the server (Firebase admin missing).');
  let uid;
  try { uid = await verifyIdToken(header.slice(7)); } catch { throw new HttpError(401, 'Your session expired. Sign in again.'); }

  const [profileSnap, subSnap] = await Promise.all([
    adminDb.collection('users').doc(uid).get(),
    adminDb.collection('subscriptions').doc(uid).get(),
  ]);
  const profile = profileSnap.exists ? profileSnap.data() : {};
  const staff = profile.role === 'admin' || profile.role === 'dev';
  const sub = subSnap.exists ? subSnap.data() : null;
  const expiry = sub?.expiryDate?.toDate?.()?.getTime() ?? Number(profile.subscriptionExpiresAt || 0);
  const planned = [sub?.packageId, profile.plan, profile.tier].some((v) => typeof v === 'string' && /starter|pro|elite|vip/i.test(v));
  const paid = subSnap.exists
    ? sub?.status === 'active' && expiry > Date.now() && planned
    : profile.status === 'approved' && planned && (!expiry || expiry > Date.now());
  return { uid, staff, paid: staff || paid };
}

const wrap = (handler, { staffOnly = false } = {}) => async (req, res) => {
  try {
    const access = await getAccess(req);
    if (!access.paid) throw new HttpError(403, 'An active plan is required for AI trading.');
    if (staffOnly && !access.staff) throw new HttpError(403, 'Order execution is limited to the account owner.');
    if (!oanda.oandaReady()) throw new HttpError(503, 'Broker connection is not configured on the server.');
    await handler(req, res, access);
  } catch (err) {
    sendError(res, err);
  }
};

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ ok: false, error: err.message, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) });
  if (err instanceof twelveData.TwelveDataError) {
    console.error('[trading] Twelve Data error:', err.status, err.message);
    return res.status(err.status === 429 ? 429 : err.status === 400 ? 400 : 502).json({ ok: false, error: `Chart data error: ${err.message}` });
  }
  if (err instanceof OandaError) {
    if (err.status === 429) return res.status(429).json({ ok: false, error: 'The broker is rate limiting requests. Wait a few seconds and try again.', retryAfter: err.retryAfter || 5 });
    console.error('[trading] OANDA error:', err.status, err.message);
    return res.status(502).json({ ok: false, error: `Broker error: ${err.message}` });
  }
  console.error('[trading] unexpected error:', err);
  return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
}

function resolvePair(raw) {
  const key = String(raw || 'XAUUSD').toUpperCase().replace(/[^A-Z]/g, '');
  const instrument = TRADING_PAIRS[key];
  if (!instrument) throw new HttpError(400, `Unsupported pair "${raw}". Supported: ${Object.keys(TRADING_PAIRS).join(', ')}.`);
  return { pair: key, instrument };
}

// ---------------------------------------------------------------------------
// Market snapshot (live quote + candles + indicators across timeframes), short server cache.
// ---------------------------------------------------------------------------
const snapshotCache = new Map(); // instrument -> { at, value }
const SNAPSHOT_TTL_MS = 5_000;

async function loadSnapshot(instrument) {
  const hit = snapshotCache.get(instrument);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.value;

  const meta = await oanda.getInstrument(instrument);
  const [quote, m5, m15, h1, h4] = await Promise.all([
    oanda.getPricing(instrument),
    oanda.getCandles(instrument, 'M5', 250),
    oanda.getCandles(instrument, 'M15', 250),
    oanda.getCandles(instrument, 'H1', 250),
    oanda.getCandles(instrument, 'H4', 250),
  ]);
  const p = meta.displayPrecision;
  const summaries = {
    M5: summarizeTimeframe(m5, { precision: p }),
    M15: summarizeTimeframe(m15, { precision: p }),
    H1: summarizeTimeframe(h1, { precision: p }),
    H4: summarizeTimeframe(h4, { precision: p }),
  };
  if (!summaries.M15 || !summaries.H1) throw new HttpError(502, 'Not enough market history returned to analyse this pair.');

  const value = { meta, quote, summaries, candles: { M15: m15, H1: h1 }, fetchedAt: Date.now() };
  snapshotCache.set(instrument, { at: Date.now(), value });
  return value;
}

function marketIsStale(snapshot) {
  const lastM15 = snapshot.summaries.M15.lastCandleTime;
  return !snapshot.quote.tradeable || Date.now() - lastM15 > 45 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// AI analysis
// ---------------------------------------------------------------------------
const SignalSchema = {
  type: Type.OBJECT,
  properties: {
    direction: { type: Type.STRING, enum: ['buy', 'sell', 'hold'] },
    entry: { type: Type.NUMBER },
    stopLoss: { type: Type.NUMBER },
    takeProfit: { type: Type.NUMBER },
    riskReward: { type: Type.NUMBER },
    confidence: { type: Type.NUMBER },
    reason: { type: Type.STRING },
  },
  required: ['direction', 'confidence', 'reason'],
};

function buildPrompt({ pair, snapshot }) {
  const { summaries, quote, candles, meta } = snapshot;
  const tail = (arr, n) => arr.slice(-n).map((c) => [new Date(c.time).toISOString().slice(5, 16), c.open, c.high, c.low, c.close, c.volume]);
  return [
    `You are a disciplined discretionary trader analysing ${pair}. Capital preservation comes first: "hold" is a normal, good answer.`,
    'Use ONLY the data below. Do not invent prices. Every number you return must be a price on this instrument.',
    '',
    `Live quote: bid ${quote.bid}, ask ${quote.ask}, spread ${(quote.ask - quote.bid).toFixed(meta.displayPrecision)}.`,
    `UTC now: ${new Date().toISOString()}.`,
    '',
    'Indicator snapshots per timeframe (EMA20/50/200, RSI14, MACD(12,26,9), ATR14, efficiencyRatio = trendiness 0..1, support/resistance):',
    JSON.stringify(summaries),
    '',
    'Recent M15 candles [time, open, high, low, close, volume] (last 40):',
    JSON.stringify(tail(candles.M15, 40)),
    'Recent H1 candles (last 24):',
    JSON.stringify(tail(candles.H1, 24)),
    '',
    'Rules:',
    `- Return direction "hold" if the market is choppy/ranging, timeframes disagree, price sits in the middle of a range, or you are not at least ${LIMITS.minConfidence}% confident.`,
    '- For buy/sell: entry should be at/near the live price, the stop-loss must sit beyond a real structural level (support/resistance or swing) and be 0.5-4 x M15 ATR away.',
    `- The take-profit must give at least 1:${LIMITS.minRr} risk-reward and target a realistic level (e.g. the next support/resistance).`,
    '- confidence is 0-100 and must reflect real conviction; do not inflate it.',
    '- reason: one or two short sentences citing the specific evidence (trend, RSI, MACD, level).',
  ].join('\n');
}

async function callAi(prompt) {
  if (!genai) throw new HttpError(503, 'AI is not configured on the server (GEMINI_API_KEY missing).');
  try {
    const response = await genai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: SignalSchema,
        temperature: 0.2,
        maxOutputTokens: 1200,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    if (!response.text) throw new Error('empty AI response');
    return JSON.parse(response.text);
  } catch (err) {
    const msg = String(err?.message || err);
    if (err?.status === 429 || /RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
      throw new HttpError(429, 'The AI service is rate limited. Try again in a minute.', { retryAfter: 60 });
    }
    if (err instanceof SyntaxError) return null; // invalid JSON -> caller retries once
    if (err instanceof HttpError) throw err;
    console.error('[trading] AI call failed:', msg);
    return undefined; // transient failure -> caller retries once
  }
}

// Shared by the manual "Analyse" button and the background scanner.
// Returns { base, signal } where signal.direction may be 'hold'.
export async function produceSignal(pair, instrument) {
  const snapshot = await loadSnapshot(instrument);
  const { meta, quote, summaries } = snapshot;
  const base = { pair, instrument, market: { bid: quote.bid, ask: quote.ask, summaries }, generatedAt: Date.now() };
  const hold = (reason, confidence = 0) => ({ base, signal: { direction: 'hold', confidence, reason } });

  if (marketIsStale(snapshot)) return hold('Market is closed or the data feed is stale. No trade.');
  if (isChoppy(summaries)) return hold('Market is choppy: neither M15 nor H1 shows a directional move. No trade.');

  const atr15 = summaries.M15.atr14;
  const mid = (quote.bid + quote.ask) / 2;
  const prompt = buildPrompt({ pair, snapshot });

  let validated = null;
  let lastReason = 'The AI response could not be validated.';
  for (let attempt = 0; attempt < 2 && !validated; attempt += 1) {
    const raw = await callAi(prompt);
    if (!raw) { lastReason = 'The AI returned an unreadable response.'; continue; }
    const result = validateAiSignal(raw, { price: mid, atr: atr15, precision: meta.displayPrecision, limits: LIMITS });
    if (result.ok) validated = result.signal; else lastReason = result.reason;
  }
  if (!validated) return hold(`No trade: ${lastReason}`);
  if (validated.direction === 'hold') return hold(validated.reason, validated.confidence);
  return { base, signal: validated, atr15, precision: meta.displayPrecision };
}

export async function storePendingSignal({ uid, pair, instrument, signal, atr15, ttlSec = LIMITS.signalTtlSec, source = 'manual' }) {
  const signalId = randomUUID();
  const expiresAt = Date.now() + ttlSec * 1000;
  await adminDb.collection(SIGNALS).doc(signalId).set({
    uid, pair, instrument, ...signal, atr15, source, status: 'pending', createdAt: Date.now(), expiresAt,
  });
  return { signalId, expiresAt };
}

const inflightAnalysis = new Set();
const lastAnalysisAt = new Map();

async function analyze(req, res, access) {
  const { pair, instrument } = resolvePair(req.body?.pair);
  const lockKey = `${access.uid}:${pair}`;
  if (inflightAnalysis.has(lockKey)) throw new HttpError(409, 'An analysis for this pair is already running.');
  const since = Date.now() - (lastAnalysisAt.get(lockKey) || 0);
  if (since < 8_000) throw new HttpError(429, 'Please wait a few seconds between analyses.', { retryAfter: Math.ceil((8_000 - since) / 1000) });
  inflightAnalysis.add(lockKey);
  lastAnalysisAt.set(lockKey, Date.now());
  try {
    const { base, signal, atr15 } = await produceSignal(pair, instrument);
    if (signal.direction === 'hold') return res.json({ ok: true, signal, ...base });
    const { signalId, expiresAt } = await storePendingSignal({ uid: access.uid, pair, instrument, signal, atr15 });
    res.json({ ok: true, signalId, expiresAt, signal, limits: publicLimits(), ...base });
  } finally {
    inflightAnalysis.delete(lockKey);
  }
}

export const publicLimits = () => ({
  riskPct: LIMITS.riskPct, maxDailyLossPct: LIMITS.maxDailyLossPct, maxOpenTrades: LIMITS.maxOpenTrades,
  minRr: LIMITS.minRr, minConfidence: LIMITS.minConfidence, signalTtlSec: LIMITS.signalTtlSec,
});

// ---------------------------------------------------------------------------
// Trade bookkeeping (Firestore) + outcome sync (OANDA)
// ---------------------------------------------------------------------------
async function syncTrades() {
  const snap = await adminDb.collection(TRADES).where('status', 'in', ['open', 'partial']).get();
  const rows = snap.docs.filter((d) => d.data().tradeId);
  if (!rows.length) return { open: [], closedNow: 0 };
  const trades = await oanda.getTradesByIds(rows.map((d) => d.data().tradeId));
  const byId = new Map(trades.map((t) => [t.id, t]));
  const open = [];
  let closedNow = 0;
  for (const d of rows) {
    const rec = d.data();
    const t = byId.get(rec.tradeId);
    if (!t) continue;
    if (t.state === 'CLOSED') {
      const closePrice = Number(t.averageClosePrice);
      const realizedPL = Number(t.realizedPL);
      const closedAt = Math.round(Number(t.closeTime) * 1000) || Date.now();
      const meta = await oanda.getInstrument(rec.instrument);
      await d.ref.update({
        status: 'closed',
        outcome: classifyOutcome(realizedPL, rec.riskAmount),
        realizedPL,
        closePrice,
        pips: pipsBetween(rec.fillPrice, closePrice, rec.direction, meta.pipSize),
        rMultiple: rec.riskAmount ? Number((realizedPL / rec.riskAmount).toFixed(2)) : null,
        closedAt,
        closeDayKey: dayKey(closedAt),
      });
      closedNow += 1;
    } else {
      open.push({ id: d.id, ...rec, unrealizedPL: Number(t.unrealizedPL), currentUnits: Number(t.currentUnits) });
    }
  }
  return { open, closedNow };
}

async function dayState() {
  const today = dayKey();
  const [closedSnap, lockSnap] = await Promise.all([
    adminDb.collection(TRADES).where('closeDayKey', '==', today).get(),
    adminDb.collection(DAYS).doc(today).get(),
  ]);
  const realized = closedSnap.docs.reduce((s, d) => s + (Number(d.data().realizedPL) || 0), 0);
  return { today, realized, locked: Boolean(lockSnap.exists && lockSnap.data().locked) };
}

async function accountRiskState() {
  const { open } = await syncTrades();
  const [account, day] = await Promise.all([oanda.getAccountSummary(), dayState()]);
  const unrealized = open.reduce((s, t) => s + (t.unrealizedPL || 0), 0);
  const dayPnl = day.realized + Math.min(0, unrealized);
  const startBalance = account.balance - day.realized;
  return { account, day, open, dayPnl, startBalance, unrealized };
}

// Serialises order placement so two confirmations can never race through the limit checks.
let executeChain = Promise.resolve();
const serialized = (fn) => {
  const run = executeChain.then(fn, fn);
  executeChain = run.catch(() => {});
  return run;
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
async function reject(tradeRef, reason, status = 422) {
  await tradeRef.update({ status: 'rejected', rejectReason: reason, updatedAt: Date.now() });
  throw new HttpError(status, reason);
}

async function execute(req, res, access) {
  const signalId = String(req.body?.signalId || '');
  if (!/^[0-9a-f-]{36}$/i.test(signalId)) throw new HttpError(400, 'Missing or invalid signal id.');

  const signalRef = adminDb.collection(SIGNALS).doc(signalId);
  const tradeRef = adminDb.collection(TRADES).doc(signalId);

  // Atomic claim: the first request for a signal wins; every later one (double-click, retry,
  // second tab) sees the existing record and gets its status back instead of a second order.
  const claim = await adminDb.runTransaction(async (tx) => {
    const [sigSnap, tradeSnap] = await Promise.all([tx.get(signalRef), tx.get(tradeRef)]);
    if (tradeSnap.exists) return { existing: tradeSnap.data() };
    if (!sigSnap.exists) throw new HttpError(404, 'Signal not found. Run the analysis again.');
    const sig = sigSnap.data();
    if (sig.uid !== access.uid && !(sig.uid === 'scanner' && access.staff)) throw new HttpError(403, 'This signal belongs to another user.');
    if (Date.now() > sig.expiresAt) throw new HttpError(410, 'This signal expired. Run the analysis again.');
    tx.set(tradeRef, {
      uid: access.uid, signalId, pair: sig.pair, instrument: sig.instrument, direction: sig.direction,
      plannedEntry: sig.entry, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, plannedRr: sig.riskReward,
      confidence: sig.confidence, reason: sig.reason, atr15: sig.atr15,
      status: 'submitting', createdAt: Date.now(), dayKey: dayKey(),
    });
    tx.update(signalRef, { status: 'consumed' });
    return { signal: sig };
  });

  if (claim.existing) {
    return res.json({ ok: true, duplicate: true, trade: publicTrade(signalId, claim.existing) });
  }
  const sig = claim.signal;

  const result = await serialized(async () => {
    try {
      const risk = await accountRiskState();
      const gate = checkAccountLimits({
        startBalance: risk.startBalance, dayPnl: risk.dayPnl, locked: risk.day.locked,
        openTrades: risk.account.openTradeCount, limits: LIMITS,
      });
      if (!gate.ok) {
        if (gate.lockDay) await adminDb.collection(DAYS).doc(risk.day.today).set({ locked: true, lockedAt: Date.now(), dayPnl: risk.dayPnl }, { merge: true });
        await reject(tradeRef, gate.reason, 403);
      }

      const [quote, meta] = await Promise.all([oanda.getPricing(sig.instrument), oanda.getInstrument(sig.instrument)]);
      const cond = checkExecutionConditions({ signal: sig, bid: quote.bid, ask: quote.ask, atr: sig.atr15, tradeable: quote.tradeable, limits: LIMITS });
      if (!cond.ok) await reject(tradeRef, cond.reason, 409);

      const quoteCcy = sig.instrument.split('_')[1];
      const conv = quote.homeConversions.find((c) => c.currency === quoteCcy);
      const lossFactor = quoteCcy === risk.account.currency ? 1 : (quote.lossFactor || Number(conv?.accountLoss) || null);
      if (!lossFactor) await reject(tradeRef, 'Could not convert the instrument currency to the account currency.', 502);

      const size = computePositionUnits({
        balance: risk.account.balance, riskPct: LIMITS.riskPct, entry: cond.refPrice, stopLoss: sig.stopLoss,
        lossPerUnitPerPrice: lossFactor, unitsPrecision: meta.unitsPrecision, minUnits: meta.minUnits, maxUnits: meta.maxUnits,
      });
      if (!size.ok) await reject(tradeRef, size.reason, 422);

      const marginNeeded = size.units * cond.refPrice * meta.marginRate;
      if (marginNeeded > risk.account.marginAvailable * 0.9) await reject(tradeRef, 'Not enough free margin for this position size.', 422);

      const signedUnits = sig.direction === 'buy' ? size.units : -size.units;
      await tradeRef.update({ status: 'sending', units: signedUnits, riskAmount: size.riskAmount, riskPct: LIMITS.riskPct, sentAt: Date.now() });

      let fill;
      try {
        fill = await oanda.placeMarketOrder({
          instrument: sig.instrument, units: signedUnits, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit,
          clientId: `genz-${signalId}`, precision: meta.displayPrecision,
        });
      } catch (err) {
        if (err instanceof OandaError && err.ambiguous) {
          // Timeout / 5xx: we don't know whether it was filled. Settle it by client id; never resend.
          const order = await oanda.getOrderByClientId(`genz-${signalId}`).catch(() => null);
          if (order?.state === 'FILLED') {
            const tradeIds = order.tradeOpenedID ? [order.tradeOpenedID] : [];
            const [t] = tradeIds.length ? await oanda.getTradesByIds(tradeIds) : [];
            fill = { status: 'filled', tradeId: tradeIds[0] || null, filledUnits: Math.abs(Number(t?.initialUnits || signedUnits)), requestedUnits: size.units, fillPrice: Number(t?.price || cond.refPrice) };
          } else if (order && order.state !== 'CANCELLED') {
            await tradeRef.update({ status: 'unknown', rejectReason: 'Order state could not be confirmed. Check your broker before retrying.', updatedAt: Date.now() });
            throw new HttpError(504, 'The broker did not confirm the order. Check your open positions before trying again.');
          } else if (order?.state === 'CANCELLED') {
            fill = { status: 'rejected', reason: 'Order was cancelled by the broker.' };
          } else {
            await tradeRef.update({ status: 'unknown', rejectReason: 'Order state could not be confirmed. Check your broker before retrying.', updatedAt: Date.now() });
            throw new HttpError(504, 'The broker did not confirm the order. Check your open positions before trying again.');
          }
        } else {
          await reject(tradeRef, err instanceof OandaError && err.status === 429 ? 'Broker rate limit hit. The order was not placed.' : `Order failed: ${err.message}`, err.status === 429 ? 429 : 502);
        }
      }

      if (fill.status === 'rejected') await reject(tradeRef, `Order not filled: ${fill.reason}`, 409);

      await tradeRef.update({
        status: fill.status === 'partial' ? 'partial' : 'open',
        tradeId: fill.tradeId, fillPrice: fill.fillPrice, filledUnits: fill.filledUnits, requestedUnits: fill.requestedUnits,
        openedAt: Date.now(), updatedAt: Date.now(),
        ...(fill.status === 'partial' ? { note: `Partial fill: ${fill.filledUnits} of ${fill.requestedUnits} units.` } : {}),
      });
      return (await tradeRef.get()).data();
    } catch (err) {
      // Anything that escaped without a terminal status must not leave the record 'submitting'.
      const cur = (await tradeRef.get()).data();
      if (cur && ['submitting', 'sending'].includes(cur.status) && !(err instanceof HttpError && err.status === 504)) {
        await tradeRef.update({ status: cur.status === 'sending' ? 'unknown' : 'failed', rejectReason: String(err.message || err).slice(0, 300), updatedAt: Date.now() }).catch(() => {});
      }
      throw err;
    }
  });

  res.json({ ok: true, trade: publicTrade(signalId, result) });
}

function publicTrade(id, t) {
  return {
    id, pair: t.pair, direction: t.direction, status: t.status, outcome: t.outcome || null,
    plannedEntry: t.plannedEntry, fillPrice: t.fillPrice ?? null, stopLoss: t.stopLoss, takeProfit: t.takeProfit,
    units: t.units ?? null, filledUnits: t.filledUnits ?? null, riskAmount: t.riskAmount ?? null, riskPct: t.riskPct ?? null,
    plannedRr: t.plannedRr, confidence: t.confidence, reason: t.reason,
    realizedPL: t.realizedPL ?? null, unrealizedPL: t.unrealizedPL ?? null, pips: t.pips ?? null, rMultiple: t.rMultiple ?? null,
    closePrice: t.closePrice ?? null, openedAt: t.openedAt ?? null, closedAt: t.closedAt ?? null, createdAt: t.createdAt,
    note: t.note || t.rejectReason || null,
  };
}

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------
async function market(req, res) {
  const { pair, instrument } = resolvePair(req.query.pair);
  const { meta, quote, summaries } = await loadSnapshot(instrument);
  res.json({
    ok: true, pair, instrument, precision: meta.displayPrecision,
    quote: { bid: quote.bid, ask: quote.ask, spread: Number((quote.ask - quote.bid).toFixed(meta.displayPrecision)), tradeable: quote.tradeable, time: quote.time },
    summaries, fetchedAt: Date.now(),
  });
}

async function latest(req, res) {
  const { pair } = resolvePair(req.query.pair);
  const snap = await adminDb.collection(SIGNALS).where('uid', '==', 'scanner').where('pair', '==', pair).get();
  const fresh = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => d.status === 'pending' && d.expiresAt > Date.now())
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!fresh) return res.json({ ok: true, signal: null });
  const { id, uid, status: _s, createdAt, expiresAt, instrument, atr15, source, ...signal } = fresh;
  res.json({ ok: true, signalId: id, expiresAt, signal, limits: publicLimits(), pair, scanner: true });
}

async function scannerHealth(req, res) {
  const snap = await adminDb.collection('aiScannerState').doc('main').get();
  res.json({ ok: true, scanner: snap.exists ? snap.data() : null });
}

async function status(req, res, access) {
  // Balance and PnL belong to the shared broker account, so only staff may see them.
  if (!access.staff) return res.json({ ok: true, canExecute: false, limits: publicLimits() });
  const risk = await accountRiskState();
  res.json({
    ok: true,
    canExecute: access.staff,
    limits: publicLimits(),
    account: { currency: risk.account.currency, balance: risk.account.balance },
    today: {
      date: risk.day.today, realizedPL: risk.day.realized, dayPnl: Number(risk.dayPnl.toFixed(2)),
      lossLimit: Number((risk.startBalance * LIMITS.maxDailyLossPct / 100).toFixed(2)),
      locked: risk.day.locked || risk.dayPnl <= -(risk.startBalance * LIMITS.maxDailyLossPct / 100),
      openTrades: risk.account.openTradeCount,
    },
  });
}

async function positions(req, res) {
  const { open } = await syncTrades();
  res.json({ ok: true, positions: open.sort((a, b) => b.createdAt - a.createdAt).map((t) => publicTrade(t.id, t)) });
}

async function history(req, res, access) {
  await syncTrades();
  const snap = await adminDb.collection(TRADES).where('uid', '==', access.uid).get();
  const all = snap.docs.map((d) => publicTrade(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
  const closed = all.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => t.outcome === 'win').length;
  const losses = closed.filter((t) => t.outcome === 'loss').length;
  res.json({
    ok: true,
    trades: all.slice(0, 100),
    summary: {
      closed: closed.length, wins, losses, breakeven: closed.length - wins - losses,
      winRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
      netPL: Number(closed.reduce((s, t) => s + (t.realizedPL || 0), 0).toFixed(2)),
      totalPips: Number(closed.reduce((s, t) => s + (t.pips || 0), 0).toFixed(1)),
    },
  });
}

// Public, read-only chart candles (no account data) for the site's AI chart. Short cache so many
// viewers cost the broker one request per pair per couple of seconds.
const candleCache = new Map();
const CHART_TFS = { M1: 'M1', M5: 'M5', M15: 'M15', H1: 'H1', H4: 'H4', D: 'D' };
async function chartCandles(req, res) {
  try {
    const useOanda = oanda.oandaReady();
    if (!useOanda && !twelveData.twelveDataReady()) return res.status(503).json({ ok: false, error: 'Live chart data is not configured on the server.' });
    const { pair, instrument } = resolvePair(req.query.pair);
    const tf = CHART_TFS[String(req.query.tf || 'M15').toUpperCase()];
    if (!tf) throw new HttpError(400, 'Unsupported timeframe.');
    const count = Math.min(500, Math.max(2, Number(req.query.count) || 300));
    const key = `${instrument}:${tf}:${count}`;
    const hit = candleCache.get(key);
    // Twelve Data's free tier is rate limited (8/min), so cache longer than OANDA.
    const ttl = useOanda ? 2000 : 15_000;
    if (hit && Date.now() - hit.at < ttl) return res.json(hit.value);
    const [meta, candles] = useOanda
      ? await Promise.all([
        oanda.getInstrument(instrument),
        oanda.getCandles(instrument, tf, count, { includeIncomplete: true }),
      ])
      : [twelveData.getMeta(pair), await twelveData.getCandles(pair, tf, count)];
    const value = { ok: true, pair, tf, precision: meta.displayPrecision, pipSize: meta.pipSize, candles, serverTime: Date.now() };
    candleCache.set(key, { at: Date.now(), value });
    res.json(value);
  } catch (err) {
    sendError(res, err);
  }
}

export function registerTradingRoutes(app) {
  const analyzeLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many analyses. Wait a minute.' } });
  const executeLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many order attempts. Wait a minute.' } });
  const readLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests.' } });

  app.get('/api/trading/candles', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests.' } }), chartCandles);
  app.get('/api/trading/market', readLimiter, wrap(market));
  app.get('/api/trading/status', readLimiter, wrap(status));
  app.get('/api/trading/latest', readLimiter, wrap(latest));
  app.get('/api/trading/scanner', readLimiter, wrap(scannerHealth));
  app.get('/api/trading/positions', readLimiter, wrap(positions, { staffOnly: true }));
  app.get('/api/trading/history', readLimiter, wrap(history, { staffOnly: true }));
  app.post('/api/trading/analyze', analyzeLimiter, wrap(analyze));
  app.post('/api/trading/execute', executeLimiter, wrap(execute, { staffOnly: true }));
}
