import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI, Type } from '@google/genai';
import { registerPaymentRoutes } from './payment.js';
import { registerPasswordResetRoutes } from './passwordReset.js';
import { registerAdminUserRoutes } from './adminUsers.js';
import { adminDb, firebaseAdminReady, verifyIdToken } from './firebaseAdmin.js';

const PORT = process.env.PORT || 3001;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
// Free tier, no credit card — get one at https://aistudio.google.com/apikey
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const GEMINI_MODEL = 'gemini-2.5-flash';

// Shared helper for every AI call below — asks Gemini for JSON matching a
// schema and parses it. Gemini takes system + user instructions as one
// combined prompt string (no separate system-role field used here).
//
// thinkingBudget: 0 disables Gemini 2.5's internal "thinking" tokens, which
// otherwise silently eat into maxOutputTokens and can truncate the visible
// JSON response mid-string (bit us on Khmer output, which tokenizes less
// densely per character than English) — not needed for straightforward
// classification/summarization like this anyway.
async function generateJson(prompt, schema, maxOutputTokens = 3000) {
  const response = await genai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  if (!response.text) {
    throw new Error(`Gemini returned no text (finishReason: ${response.candidates?.[0]?.finishReason}).`);
  }
  return JSON.parse(response.text);
}
// Comma-separated list, e.g. "https://genztrader.com,http://localhost:5173".
// Left unset (or "*") allows any origin, since this endpoint only reads
// public news and needs no auth.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;

const app = express();
// Railway sits in front of this app as a reverse proxy, so every request
// arrives with an X-Forwarded-For header set by Railway itself (not by the
// client) — without this, express-rate-limit can't tell it's safe to trust
// that header and throws on every request instead of rate-limiting by the
// real visitor IP. `1` trusts exactly one hop (Railway's own proxy), not
// an arbitrary chain a malicious client could spoof.
app.set('trust proxy', 1);
app.use(
  cors({
    origin: FRONTEND_ORIGIN ? FRONTEND_ORIGIN.split(',').map((s) => s.trim()) : '*',
  })
);
app.use(express.json({ limit: '10mb' }));

// Every request here costs either a paid third-party API call (Gemini,
// NewsAPI, Finnhub) or writes to Firestore — without a cap, a script could
// burn through daily quotas or hammer the payment-grant endpoint. Generous
// enough for normal browsing, tight enough to blunt scripted abuse.
const generalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const costlyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
const pipLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use(generalLimiter);

const PIP_IMAGE_SIGNAL_LIMITS = { starter: 4, pro: 12, elite: 20 };

async function reservePipImageSignal(req) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) {
    const error = new Error('Sign in to request a chart signal.');
    error.status = 401;
    throw error;
  }
  if (!firebaseAdminReady) {
    const error = new Error('Pip image signal limits are not configured on the server.');
    error.status = 503;
    throw error;
  }

  let uid;
  try {
    uid = await verifyIdToken(authorization.slice(7));
  } catch {
    const error = new Error('Your session expired. Sign in again to request a chart signal.');
    error.status = 401;
    throw error;
  }

  const userRef = adminDb.collection('users').doc(uid);
  const subscriptionRef = adminDb.collection('subscriptions').doc(uid);
  const profileSnap = await userRef.get();
  const profile = profileSnap.exists ? profileSnap.data() : {};
  if (profile.role === 'admin' || profile.role === 'dev') {
    return { uid, unlimited: true, limit: -1, used: 0, remaining: -1 };
  }

  const subscriptionSnap = await subscriptionRef.get();
  const subscription = subscriptionSnap.exists ? subscriptionSnap.data() : null;
  const planId = String(subscription?.packageId || '').toLowerCase();
  const limit = PIP_IMAGE_SIGNAL_LIMITS[planId];
  const expiryDate = subscription?.expiryDate?.toDate?.();
  if (subscription?.status !== 'active' || !expiryDate || expiryDate <= new Date() || !limit) {
    const error = new Error('An active Starter, Pro, or Elite subscription is required to request chart signals.');
    error.status = 403;
    throw error;
  }

  const now = new Date();
  const windowStart = now.getTime() - 24 * 60 * 60 * 1000;
  const requestId = `${now.getTime()}_${Math.random().toString(36).slice(2)}`;
  const usageRef = adminDb.collection('pipImageSignalUsage').doc(uid);
  const result = await adminDb.runTransaction(async (tx) => {
    const usageSnap = await tx.get(usageRef);
    const storedRequests = usageSnap.exists && Array.isArray(usageSnap.data().requests)
      ? usageSnap.data().requests
      : [];
    const activeRequests = storedRequests.filter((item) => {
      const createdAt = item?.createdAt?.toDate?.() || new Date(item?.createdAt);
      return Number.isFinite(createdAt.getTime()) && createdAt.getTime() > windowStart;
    });
    const used = activeRequests.length;
    if (used >= limit) {
      const nextResetAt = new Date(Math.min(...activeRequests.map((item) => (
        (item.createdAt?.toDate?.() || new Date(item.createdAt)).getTime()
      ))) + 24 * 60 * 60 * 1000);
      const error = new Error(`You have used all ${limit} chart signal requests in the last 24 hours. A request becomes available again after an earlier request reaches its 24-hour expiry.`);
      error.status = 429;
      error.quota = { planId, limit, used, remaining: 0, resetsAt: nextResetAt.toISOString() };
      throw error;
    }
    const requests = [...activeRequests, { id: requestId, createdAt: now }];
    tx.set(usageRef, {
      userId: uid,
      planId,
      limit,
      used: requests.length,
      requests,
      updatedAt: new Date(),
    }, { merge: true });
    const nextResetAt = new Date(Math.min(...requests.map((item) => item.createdAt.getTime())) + 24 * 60 * 60 * 1000);
    return { uid, usageRef, requestId, planId, limit, used: requests.length, remaining: limit - requests.length, resetsAt: nextResetAt.toISOString() };
  });
  return result;
}

async function releasePipImageSignal(reservation) {
  if (!reservation?.usageRef) return;
  await adminDb.runTransaction(async (tx) => {
    const usageSnap = await tx.get(reservation.usageRef);
    if (!usageSnap.exists) return;
    const requests = Array.isArray(usageSnap.data().requests) ? usageSnap.data().requests : [];
    const remainingRequests = requests.filter((item) => item.id !== reservation.requestId);
    if (!remainingRequests.length) tx.delete(reservation.usageRef);
    else tx.update(reservation.usageRef, { requests: remainingRequests, used: remainingRequests.length, updatedAt: new Date() });
  });
}

app.get('/api/member/signals', pipLimiter, async (req, res) => {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!firebaseAdminReady) {
    return res.status(503).json({ error: 'Signal access is not configured on the server.' });
  }

  try {
    const uid = await verifyIdToken(authorization.slice(7));
    const [profileSnap, subscriptionSnap] = await Promise.all([
      adminDb.collection('users').doc(uid).get(),
      adminDb.collection('subscriptions').doc(uid).get(),
    ]);
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const isStaff = profile.role === 'admin' || profile.role === 'dev';
    const subscription = subscriptionSnap.exists ? subscriptionSnap.data() : null;
    const expiresAt = subscription?.expiryDate?.toDate?.()?.getTime()
      ?? Number(profile.subscriptionExpiresAt || 0);
    const planCandidates = [subscription?.packageId, profile.plan, profile.tier]
      .filter((value) => typeof value === 'string')
      .map((value) => value.toLowerCase());
    const normalizedPlan = planCandidates.some((value) => value.includes('elite')) ? 'elite'
      : planCandidates.some((value) => value.includes('pro')) ? 'pro'
      : planCandidates.some((value) => value.includes('starter') || value === 'vip') ? 'starter'
      : null;
    const hasPaidAccess = subscriptionSnap.exists
      ? subscription?.status === 'active' && expiresAt > Date.now() && Boolean(normalizedPlan)
      : profile.status === 'approved' && Boolean(normalizedPlan)
        && (!expiresAt || expiresAt > Date.now());

    if (!isStaff && !hasPaidAccess) {
      return res.status(403).json({ error: 'An active Starter, Pro, or Elite plan is required to view signals.' });
    }

    const signalSnapshot = await adminDb.collection('signals').orderBy('createdAt', 'desc').get();
    const allSignals = signalSnapshot.docs.map((snapshot) => {
      const data = snapshot.data();
      const createdAtMs = data.createdAt?.toMillis?.() ?? Number(data.publishedAt || Date.now());
      return {
        id: snapshot.id,
        ...data,
        createdAt: createdAtMs,
        minutesAgo: Math.max(0, Math.floor((Date.now() - createdAtMs) / 60_000)),
        _createdAtMs: createdAtMs,
      };
    });

    let visibleSignals = allSignals;
    let visibilityPercent = 100;
    if (!isStaff) {
      const share = normalizedPlan === 'starter' ? 0.5 : normalizedPlan === 'pro' ? 0.75 : 1;
      visibilityPercent = Math.round(share * 100);
      const byDay = new Map();
      for (const signal of allSignals) {
        const day = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(signal._createdAtMs));
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(signal);
      }
      visibleSignals = [];
      for (const dailySignals of byDay.values()) {
        dailySignals.sort((a, b) => b._createdAtMs - a._createdAtMs);
        visibleSignals.push(...dailySignals.slice(0, Math.ceil(dailySignals.length * share)));
      }
    }

    res.json({
      signals: visibleSignals
        .sort((a, b) => b._createdAtMs - a._createdAtMs)
        .map(({ _createdAtMs, ...signal }) => signal),
      plan: isStaff ? 'staff' : normalizedPlan,
      visibilityPercent,
    });
  } catch (error) {
    console.error('Member signal feed failed:', error);
    res.status(500).json({ error: 'Could not load the signal feed.' });
  }
});

// =========================================================================
// AUTHORITATIVE MARKET DATA & SIGNAL VALIDATION SERVICE
// =========================================================================
const SUPPORTED_ASSETS = ['XAUUSD', 'XAGUSD', 'BTCUSD'];

function normalizeAssetSymbol(sym) {
  if (!sym || typeof sym !== 'string') return '';
  const clean = sym.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.includes('XAU') || clean.includes('GOLD')) return 'XAUUSD';
  if (clean.includes('XAG') || clean.includes('SILVER')) return 'XAGUSD';
  if (clean.includes('BTC')) return 'BTCUSD';
  return clean;
}

let marketPriceCache = {
  data: {},
  timestamp: 0,
};

async function fetchAuthoritativeMarketPrices() {
  const now = Date.now();
  if (now - marketPriceCache.timestamp < 3000 && Object.keys(marketPriceCache.data).length === 3) {
    return marketPriceCache.data;
  }

  const prices = {};

  // 1. Fetch Bitcoin (BTCUSDT) from Binance Live Ticker
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      const p = parseFloat(data.price);
      if (Number.isFinite(p) && p > 10000) {
        prices.BTCUSD = {
          price: p,
          currency: 'USD',
          timestamp: now,
          source: 'Binance Public Spot Ticker',
          isAvailable: true,
        };
      }
    }
  } catch (err) {
    console.warn('[Server Market] BTC price fetch fallback notice:', err.message);
  }

  // Fallback for BTC if Binance timed out: Gold-API
  if (!prices.BTCUSD) {
    try {
      const res = await fetch('https://api.gold-api.com/price/BTC', {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        const p = parseFloat(data.price);
        if (Number.isFinite(p) && p > 10000) {
          prices.BTCUSD = {
            price: p,
            currency: 'USD',
            timestamp: now,
            source: 'Gold-API Public Feed',
            isAvailable: true,
          };
        }
      }
    } catch {}
  }

  // 2. Fetch Gold (XAUUSD) & Silver (XAGUSD) via TradingView CFD Scanner
  try {
    const tvPayload = {
      filter: [{ left: 'name', operation: 'in_range', right: ['XAUUSD', 'SILVER'] }],
      options: { lang: 'en' },
      symbols: { query: { types: [] }, tickers: [] },
      columns: ['close', 'name', 'description'],
      sort: { sortBy: 'name', sortOrder: 'asc' },
      range: [0, 10],
    };
    const res = await fetch('https://scanner.tradingview.com/cfd/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tvPayload),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.data)) {
        for (const row of data.data) {
          const sym = row.s;
          const close = row.d?.[0];
          if (sym.includes('XAUUSD') && close > 1000) {
            prices.XAUUSD = {
              price: close,
              currency: 'USD',
              timestamp: now,
              source: 'TradingView CFD (OANDA:XAUUSD)',
              isAvailable: true,
            };
          } else if ((sym.includes('SILVER') || sym.includes('XAGUSD')) && close > 10) {
            prices.XAGUSD = {
              price: close,
              currency: 'USD',
              timestamp: now,
              source: 'TradingView CFD (TVC:SILVER)',
              isAvailable: true,
            };
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Server Market] TV Metals scanner notice:', err.message);
  }

  // Fallback for Gold if TV scan missed it: Gold-API
  if (!prices.XAUUSD) {
    try {
      const res = await fetch('https://api.gold-api.com/price/XAU', {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        const p = parseFloat(data.price);
        if (Number.isFinite(p) && p > 1000) {
          prices.XAUUSD = {
            price: p,
            currency: 'USD',
            timestamp: now,
            source: 'Gold-API Spot Feed',
            isAvailable: true,
          };
        }
      }
    } catch {}
  }

  // Fallback for Silver if TV scan missed it: Gold-API
  if (!prices.XAGUSD) {
    try {
      const res = await fetch('https://api.gold-api.com/price/XAG', {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        const p = parseFloat(data.price);
        if (Number.isFinite(p) && p > 10) {
          prices.XAGUSD = {
            price: p,
            currency: 'USD',
            timestamp: now,
            source: 'Gold-API Spot Feed',
            isAvailable: true,
          };
        }
      }
    } catch {}
  }

  // Update in-memory cache
  marketPriceCache = {
    data: prices,
    timestamp: now,
  };

  return prices;
}

function validateTradingSignalServer(signal, spotPrice) {
  if (!signal || typeof signal !== 'object') {
    return { isValid: false, reasonCode: 'SIGNAL_EMPTY', message: 'Signal object missing.' };
  }

  const rawPair = signal.pair || signal.symbol;
  const pair = normalizeAssetSymbol(rawPair);
  if (!SUPPORTED_ASSETS.includes(pair)) {
    return {
      isValid: false,
      reasonCode: 'UNSUPPORTED_PAIR',
      message: `Asset ${rawPair} is not supported. Supported: XAU/USD, XAG/USD, BTC/USD.`,
    };
  }

  const direction = String(signal.direction || signal.type || signal.action || '').toUpperCase();
  if (direction !== 'BUY' && direction !== 'SELL') {
    return { isValid: false, reasonCode: 'INVALID_DIRECTION', message: `Invalid trade direction '${direction}'.` };
  }

  const entry = Number(signal.entry ?? signal.entry_price ?? signal.entryPrice);
  const sl = Number(signal.sl ?? signal.stop_loss ?? signal.stopLoss);
  const tp = Number(signal.tp ?? signal.tp1 ?? signal.take_profit ?? signal.takeProfit);

  if (!Number.isFinite(entry) || entry <= 0) {
    return { isValid: false, reasonCode: 'INVALID_ENTRY', message: `Invalid entry level: ${entry}` };
  }
  if (!Number.isFinite(sl) || sl <= 0) {
    return { isValid: false, reasonCode: 'INVALID_SL', message: `Invalid stop-loss level: ${sl}` };
  }
  if (!Number.isFinite(tp) || tp <= 0) {
    return { isValid: false, reasonCode: 'INVALID_TP', message: `Invalid take-profit level: ${tp}` };
  }

  // Check market price consistency if spotPrice available
  if (Number.isFinite(spotPrice) && spotPrice > 0) {
    const deviation = Math.abs(entry - spotPrice) / spotPrice;
    if (deviation > 0.0035) {
      return {
        isValid: false,
        reasonCode: 'PRICE_DEVIATION_TOO_LARGE',
        message: `Entry ${entry} deviates ${(deviation * 100).toFixed(2)}% from live market price ${spotPrice}.`,
      };
    }
  }

  // Level geometry
  if (direction === 'BUY') {
    if (sl >= entry) {
      return { isValid: false, reasonCode: 'INVALID_BUY_GEOMETRY', message: `For BUY setup, Stop Loss (${sl}) must be strictly below Entry (${entry}).` };
    }
    if (tp <= entry) {
      return { isValid: false, reasonCode: 'INVALID_BUY_GEOMETRY', message: `For BUY setup, Take Profit (${tp}) must be strictly above Entry (${entry}).` };
    }
  } else {
    if (sl <= entry) {
      return { isValid: false, reasonCode: 'INVALID_SELL_GEOMETRY', message: `For SELL setup, Stop Loss (${sl}) must be strictly above Entry (${entry}).` };
    }
    if (tp >= entry) {
      return { isValid: false, reasonCode: 'INVALID_SELL_GEOMETRY', message: `For SELL setup, Take Profit (${tp}) must be strictly below Entry (${entry}).` };
    }
  }

  // Minimum distances
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);

  let minSlDist = 1.5;
  let minTpDist = 3.0;
  if (pair === 'XAGUSD') {
    minSlDist = 0.10;
    minTpDist = 0.20;
  } else if (pair === 'BTCUSD') {
    minSlDist = 200.0;
    minTpDist = 400.0;
  }

  if (slDist < minSlDist) {
    return { isValid: false, reasonCode: 'SL_TOO_TIGHT', message: `Stop Loss distance ${slDist.toFixed(2)} is less than minimum ${minSlDist}.` };
  }
  if (tpDist < minTpDist) {
    return { isValid: false, reasonCode: 'TP_TOO_TIGHT', message: `Take Profit distance ${tpDist.toFixed(2)} is less than minimum ${minTpDist}.` };
  }

  // Risk / Reward ratio
  const rr = tpDist / slDist;
  const minRr = signal.style === 'scalping' ? 1.4 : 1.5;
  if (rr < minRr) {
    return { isValid: false, reasonCode: 'INSUFFICIENT_RR', message: `R:R ratio 1:${rr.toFixed(2)} is below minimum 1:${minRr.toFixed(1)}.` };
  }

  return {
    isValid: true,
    normalized: {
      pair,
      direction,
      entry,
      sl,
      tp,
      rr: `1:${rr.toFixed(1)}`,
      validatedAt: Date.now(),
    },
  };
}

// 1. Authoritative All Prices Endpoint
app.get('/api/market/prices', async (req, res) => {
  try {
    const prices = await fetchAuthoritativeMarketPrices();
    res.json({
      success: true,
      timestamp: Date.now(),
      supportedAssets: SUPPORTED_ASSETS,
      prices,
    });
  } catch (err) {
    console.error('Market prices fetch failed:', err);
    res.status(500).json({ error: 'Failed to retrieve authoritative market prices.' });
  }
});

// 2. Authoritative Single Price Endpoint
app.get('/api/market/price', async (req, res) => {
  const rawPair = req.query.pair || req.query.symbol;
  const pair = normalizeAssetSymbol(rawPair);
  if (!pair || !SUPPORTED_ASSETS.includes(pair)) {
    return res.status(400).json({
      error: `Unsupported pair '${rawPair}'. Supported assets: XAUUSD, XAGUSD, BTCUSD.`,
    });
  }

  try {
    const prices = await fetchAuthoritativeMarketPrices();
    const item = prices[pair];
    if (!item) {
      return res.status(503).json({
        error: `Live price for ${pair} is temporarily unavailable.`,
        isAvailable: false,
      });
    }

    res.json({
      pair,
      price: item.price,
      currency: item.currency,
      timestamp: item.timestamp,
      source: item.source,
      isAvailable: item.isAvailable,
      isStale: Date.now() - item.timestamp > 15000,
    });
  } catch (err) {
    console.error(`Price fetch error for ${pair}:`, err);
    res.status(500).json({ error: 'Failed to retrieve live market price.' });
  }
});

// 3. Authoritative Signal Validation Endpoint
app.post('/api/signals/validate', async (req, res) => {
  const signal = req.body?.signal || req.body;
  if (!signal) {
    return res.status(400).json({ isValid: false, reasonCode: 'NO_PAYLOAD', message: 'Missing signal in request body.' });
  }

  try {
    const prices = await fetchAuthoritativeMarketPrices();
    const pair = normalizeAssetSymbol(signal.pair || signal.symbol);
    const spotPrice = prices[pair]?.price;

    const validation = validateTradingSignalServer(signal, spotPrice);
    res.json(validation);
  } catch (err) {
    console.error('Signal validation error:', err);
    res.status(500).json({ isValid: false, reasonCode: 'SERVER_ERROR', message: 'Signal validation service error.' });
  }
});

// Articles about gold/silver specifically as a market/price (not the word
// "gold"/"silver" used loosely, e.g. "digital gold" for Bitcoin, "silver
// lining" idioms, Olympic medals), or the US macro drivers (Fed decisions,
// inflation, jobs data, dollar strength) that most often move XAUUSD/XAGUSD
// — same "red-folder USD news" focus taught in the Forex Factory lesson.
const NEWS_QUERY =
  '("gold price" OR "gold prices" OR "gold market" OR XAUUSD OR ' +
  '"silver price" OR "silver prices" OR "silver market" OR XAGUSD OR ' +
  'bullion OR "precious metals") AND ' +
  '(Fed OR "Federal Reserve" OR inflation OR "interest rate" OR "interest rates" OR ' +
  'CPI OR "non-farm payroll" OR "jobs report" OR FOMC OR dollar OR "safe haven" OR "safe-haven")';

const CACHE_TTL_MS = 10 * 60 * 1000; // NewsAPI free tier: 100 requests/day
let cache = { articles: null, fetchedAt: 0 };

async function fetchGoldSilverNews() {
  const now = Date.now();
  if (cache.articles && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.articles;
  }

  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', NEWS_QUERY);
  url.searchParams.set('searchIn', 'title,description');
  url.searchParams.set('language', 'en');
  url.searchParams.set('sortBy', 'publishedAt');
  url.searchParams.set('pageSize', '20');

  const res = await fetch(url, { headers: { 'X-Api-Key': NEWS_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NewsAPI ${res.status}: ${body}`);
  }
  const data = await res.json();

  const articles = (data.articles || [])
    .filter((a) => a.title && a.title !== '[Removed]')
    .map((a) => ({
      title: a.title,
      description: a.description,
      url: a.url,
      source: a.source?.name || '',
      imageUrl: a.urlToImage || null,
      publishedAt: a.publishedAt,
    }));

  cache = { articles, fetchedAt: now };
  return articles;
}

const LANGUAGE_NAME = { kh: 'Khmer', en: 'English' };

// ---------------------------------------------------------------------------
// PER-ARTICLE BREAKDOWN — lets users get a gold-impact read on one specific
// article in-site, instead of clicking through to the source. Cached by
// url+lang since the same article gets asked about repeatedly and the
// content never changes; simple size cap so a long-running process doesn't
// grow this unbounded.
// ---------------------------------------------------------------------------

const ArticleAnalysisSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    impactsGold: { type: Type.BOOLEAN },
    direction: { type: Type.STRING, enum: ['bullish', 'bearish', 'neutral'] },
    confidence: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
    explanation: { type: Type.STRING },
    keyTakeaways: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['summary', 'impactsGold', 'direction', 'confidence', 'explanation', 'keyTakeaways'],
};

const articleAnalysisCache = new Map(); // `${url}|${lang}` -> result
const ARTICLE_CACHE_MAX = 500;

async function analyzeArticle({ url, title, description }, lang) {
  const cacheKey = `${url}|${lang}`;
  if (articleAnalysisCache.has(cacheKey)) {
    return articleAnalysisCache.get(cacheKey);
  }

  const languageName = LANGUAGE_NAME[lang] || 'English';

  const prompt =
    'You are a market-education assistant. Given one news article (title + a short description snippet — ' +
    'you do not have the full article body), do two things: (1) write a readable 3-5 sentence summary that ' +
    'reasonably expands on the title and description into a coherent, informative paragraph a reader could ' +
    'learn the gist of the story from, without inventing specific facts, numbers, or quotes that are not ' +
    'implied by the title/description; (2) break down whether and how this story could affect the price of ' +
    'Gold (XAUUSD) specifically. Many articles have no real connection to gold — say so plainly ' +
    '(impactsGold: false, direction: "neutral") rather than forcing a connection. This is educational, not ' +
    'financial advice.\n\n' +
    `Title: ${title}\nDescription: ${description || '(none)'}\n\n` +
    `Write "summary", "explanation", and each "keyTakeaways" entry in ${languageName}. ` +
    'Keep "direction" and "confidence" as the exact English enum values.';

  const result = await generateJson(prompt, ArticleAnalysisSchema, 2500);

  if (articleAnalysisCache.size >= ARTICLE_CACHE_MAX) {
    articleAnalysisCache.delete(articleAnalysisCache.keys().next().value);
  }
  articleAnalysisCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// ECONOMIC CALENDAR (Finnhub) — Forex Factory's own calendar returns 403
// (active Cloudflare bot-challenge) and sends X-Frame-Options: SAMEORIGIN, so
// it can neither be embedded in an iframe nor fetched programmatically from
// any other origin. Finnhub's /calendar/economic is used instead.
// ---------------------------------------------------------------------------

const COUNTRY_TO_CURRENCY = {
  US: 'USD', EU: 'EUR', GB: 'GBP', JP: 'JPY', CN: 'CNY', AU: 'AUD',
  CA: 'CAD', CH: 'CHF', NZ: 'NZD', DE: 'EUR', FR: 'EUR', IT: 'EUR',
};

// Heuristic, not authoritative: how much a given event historically tends to
// move Gold/Silver/Oil/USD. Curated for the well-known recurring US releases
// (CPI, NFP, FOMC, etc.); everything else falls back to a generic estimate
// driven by currency + Finnhub's own impact rating. Levels: none/low/medium/high/veryhigh.
const CURATED_EVENT_IMPACT = {
  cpi: { gold: 'high', silver: 'medium', oil: 'medium', usd: 'high' },
  nfp: { gold: 'high', silver: 'medium', oil: 'medium', usd: 'high' },
  fomc: { gold: 'veryhigh', silver: 'high', oil: 'medium', usd: 'veryhigh' },
  ppi: { gold: 'medium', silver: 'medium', oil: 'low', usd: 'medium' },
  gdp: { gold: 'medium', silver: 'low', oil: 'medium', usd: 'medium' },
  retail: { gold: 'medium', silver: 'low', oil: 'low', usd: 'medium' },
  claims: { gold: 'low', silver: 'low', oil: 'low', usd: 'low' },
  pmi: { gold: 'low', silver: 'low', oil: 'medium', usd: 'low' },
  unemployment: { gold: 'medium', silver: 'low', oil: 'low', usd: 'medium' },
};

function classifyEvent(name) {
  const n = name.toLowerCase();
  if (/\bcpi\b|consumer price index|inflation rate/.test(n)) return 'cpi';
  if (/non.?farm payroll|\bnfp\b/.test(n)) return 'nfp';
  if (/fomc|federal funds rate|interest rate decision|fed interest rate|monetary policy statement/.test(n)) return 'fomc';
  if (/\bppi\b|producer price index/.test(n)) return 'ppi';
  if (/\bgdp\b/.test(n)) return 'gdp';
  if (/retail sales/.test(n)) return 'retail';
  if (/unemployment claims|jobless claims/.test(n)) return 'claims';
  if (/\bpmi\b|ism manufacturing|ism services/.test(n)) return 'pmi';
  if (/unemployment rate/.test(n)) return 'unemployment';
  return null;
}

function estimateMarketImpact(event) {
  const currency = event.currency;
  const isUSD = currency === 'USD';
  const tier = classifyEvent(event.event);

  if (isUSD && tier && CURATED_EVENT_IMPACT[tier]) {
    return CURATED_EVENT_IMPACT[tier];
  }
  if (isUSD) {
    if (event.impact === 'high') return { gold: 'high', silver: 'medium', oil: 'low', usd: 'high' };
    if (event.impact === 'medium') return { gold: 'medium', silver: 'low', oil: 'low', usd: 'medium' };
    return { gold: 'low', silver: 'low', oil: 'low', usd: 'low' };
  }
  if (/crude oil inventories|opec|eia petroleum/.test(event.event.toLowerCase())) {
    return { gold: 'low', silver: 'low', oil: 'high', usd: 'low' };
  }
  if (['EUR', 'GBP', 'JPY', 'CNY'].includes(currency) && tier === 'fomc') {
    // Other major central banks' rate decisions still move DXY/gold moderately.
    return { gold: 'medium', silver: 'low', oil: 'low', usd: 'low' };
  }
  return { gold: 'none', silver: 'none', oil: 'none', usd: 'none' };
}

const CALENDAR_CACHE_TTL_MS = 20 * 60 * 1000;
let calendarCache = { events: null, fetchedAt: 0 };

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchEconomicCalendar() {
  const now = Date.now();
  if (calendarCache.events && now - calendarCache.fetchedAt < CALENDAR_CACHE_TTL_MS) {
    return calendarCache.events;
  }

  // Wide enough window for the date-navigator UI to browse both backward
  // and forward, not just "this week".
  const from = toDateStr(new Date(now - 14 * 24 * 60 * 60 * 1000));
  const to = toDateStr(new Date(now + 21 * 24 * 60 * 60 * 1000));

  const url = new URL('https://finnhub.io/api/v1/calendar/economic');
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  url.searchParams.set('token', FINNHUB_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Finnhub ${res.status}: ${body}`);
  }
  const data = await res.json();
  const raw = data.economicCalendar || data.result || [];

  const seen = new Set();
  const events = raw
    .map((e) => {
      const rawCurrency = e.currency || e.country || '';
      const currency = COUNTRY_TO_CURRENCY[rawCurrency] || rawCurrency;
      const timeStr = String(e.time || '').trim();
      // Finnhub's `time` is UTC without a zone suffix — treat it as such.
      const iso = /Z|[+-]\d{2}:\d{2}$/.test(timeStr)
        ? timeStr
        : `${timeStr.replace(' ', 'T')}Z`;
      return {
        key: `${e.event}|${timeStr}`,
        time: iso,
        currency,
        event: e.event || 'Unknown Event',
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        previous: e.prev ?? e.previous ?? null,
        unit: e.unit || '',
        impact: e.impact || 'low', // Finnhub: low | medium | high
      };
    })
    .filter((e) => {
      if (!e.time || Number.isNaN(new Date(e.time).getTime())) return false;
      if (seen.has(e.key)) return false; // dedupe
      seen.add(e.key);
      return true;
    })
    .map((e) => ({ ...e, marketImpact: estimateMarketImpact(e) }))
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  calendarCache = { events, fetchedAt: now };
  return events;
}

const CalendarAnalysisSchema = {
  type: Type.OBJECT,
  properties: {
    analyses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          key: { type: Type.STRING },
          shortExplanation: { type: Type.STRING },
          goldImpact: { type: Type.STRING, enum: ['bullish', 'bearish', 'neutral'] },
          silverImpact: { type: Type.STRING, enum: ['bullish', 'bearish', 'neutral'] },
          oilImpact: { type: Type.STRING, enum: ['bullish', 'bearish', 'neutral'] },
          reason: { type: Type.STRING },
        },
        required: ['key', 'shortExplanation', 'goldImpact', 'silverImpact', 'oilImpact', 'reason'],
      },
    },
  },
  required: ['analyses'],
};

// One batched Gemini call covers every high-impact event in the current
// calendar window, instead of one call per event — keeps API usage bounded
// regardless of how many high-impact releases are in the next 7 days.
const CALENDAR_ANALYSIS_TTL_MS = 6 * 60 * 60 * 1000;
const calendarAnalysisCache = {}; // lang -> { byKey, fetchedAt }

async function generateCalendarAnalysis(lang, highImpactEvents) {
  const cached = calendarAnalysisCache[lang];
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CALENDAR_ANALYSIS_TTL_MS) {
    return cached.byKey;
  }
  if (highImpactEvents.length === 0) return {};

  const languageName = LANGUAGE_NAME[lang] || 'English';
  const eventList = highImpactEvents
    .slice(0, 12)
    .map(
      (e, i) =>
        `${i + 1}. key="${e.key}" | ${e.time} | ${e.currency} | ${e.event} | previous=${e.previous ?? 'n/a'} estimate=${e.estimate ?? 'n/a'}`
    )
    .join('\n');

  const prompt =
    'You are a market-education assistant. For each upcoming high-impact economic event, give a short, ' +
    'calibrated read on how it could move Gold (XAUUSD), Silver (XAGUSD), and Oil (WTI). This is educational, ' +
    'not financial advice — favor "neutral" whenever the outcome is genuinely uncertain (which is normal for ' +
    'a not-yet-released data point). Return exactly one analysis object per event key given, in the same order.\n\n' +
    `Upcoming high-impact events:\n\n${eventList}\n\n` +
    `Write "shortExplanation" and "reason" in ${languageName}. ` +
    'Keep "key" identical to the given key, and "goldImpact"/"silverImpact"/"oilImpact" as the exact English enum values.';

  const parsed = await generateJson(prompt, CalendarAnalysisSchema, 6000);

  const byKey = {};
  for (const a of parsed.analyses) {
    byKey[a.key] = a;
  }
  calendarAnalysisCache[lang] = { byKey, fetchedAt: now };
  return byKey;
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'genztrader-news-api' });
});

app.use('/api/payment', costlyLimiter);
registerPaymentRoutes(app);

// Same limiter as payment: each request either sends a real email or hits
// Firebase Admin, so it needs the tighter cap too (a script hammering
// /request could otherwise spam an inbox, or hammering /confirm could
// brute-force the 6-digit code faster than MAX_ATTEMPTS would suggest).
app.use('/api/auth/password-reset', costlyLimiter);
registerPasswordResetRoutes(app);

// Same limiter: hits Firebase Admin to create a real account.
app.use('/api/admin/create-user', costlyLimiter);
registerAdminUserRoutes(app);

function getFallbackCalendarEvents() {
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 30, 0));
  const d = (dayOffset, hour = 12, min = 30) => {
    const target = new Date(base.getTime() + dayOffset * 86400000);
    target.setUTCHours(hour, min, 0, 0);
    return target.toISOString();
  };

  const templates = [
    { event: 'US Core CPI (MoM)', currency: 'USD', impact: 'high', estimate: '0.3%', previous: '0.3%', actual: null, offset: 0, hour: 12, min: 30 },
    { event: 'US Initial Jobless Claims', currency: 'USD', impact: 'high', estimate: '218K', previous: '221K', actual: null, offset: 0, hour: 12, min: 30 },
    { event: 'Federal Reserve Interest Rate Decision', currency: 'USD', impact: 'high', estimate: '5.25%', previous: '5.25%', actual: null, offset: 1, hour: 18, min: 0 },
    { event: 'FOMC Press Conference', currency: 'USD', impact: 'high', estimate: '—', previous: '—', actual: null, offset: 1, hour: 18, min: 30 },
    { event: 'US Non-Farm Payrolls (NFP)', currency: 'USD', impact: 'high', estimate: '185K', previous: '175K', actual: null, offset: 2, hour: 12, min: 30 },
    { event: 'US Unemployment Rate', currency: 'USD', impact: 'high', estimate: '3.9%', previous: '3.9%', actual: null, offset: 2, hour: 12, min: 30 },
    { event: 'US Producer Price Index (PPI MoM)', currency: 'USD', impact: 'medium', estimate: '0.2%', previous: '0.2%', actual: null, offset: 3, hour: 12, min: 30 },
    { event: 'Retail Sales (MoM)', currency: 'USD', impact: 'high', estimate: '0.4%', previous: '0.3%', actual: null, offset: 4, hour: 12, min: 30 },
    { event: 'ISM Manufacturing PMI', currency: 'USD', impact: 'high', estimate: '50.2', previous: '49.8', actual: null, offset: 5, hour: 14, min: 0 },
    { event: 'ECB Monetary Policy Statement', currency: 'EUR', impact: 'high', estimate: '3.75%', previous: '3.75%', actual: null, offset: 2, hour: 12, min: 15 },
    { event: 'BOE Interest Rate Decision', currency: 'GBP', impact: 'high', estimate: '5.00%', previous: '5.00%', actual: null, offset: 3, hour: 11, min: 0 },
  ];

  return templates.map((t) => {
    const timeIso = d(t.offset, t.hour, t.min);
    const item = {
      key: `${t.event}|${timeIso}`,
      time: timeIso,
      currency: t.currency,
      event: t.event,
      actual: t.actual,
      estimate: t.estimate,
      previous: t.previous,
      unit: '%',
      impact: t.impact,
    };
    return {
      ...item,
      marketImpact: estimateMarketImpact(item),
    };
  });
}

app.get('/api/calendar', async (req, res) => {
  const lang = ['kh', 'en'].includes(req.query.lang) ? req.query.lang : 'en';
  try {
    let events = null;
    if (FINNHUB_API_KEY) {
      try {
        events = await fetchEconomicCalendar();
      } catch (finnhubErr) {
        console.warn('Finnhub economic calendar fetch failed, using fallback:', finnhubErr.message);
      }
    }
    if (!events || events.length === 0) {
      events = calendarCache.events && calendarCache.events.length > 0
        ? calendarCache.events
        : getFallbackCalendarEvents();
    }

    let analysisByKey = {};
    if (genai) {
      const highImpact = events.filter((e) => e.impact === 'high');
      try {
        analysisByKey = await generateCalendarAnalysis(lang, highImpact);
      } catch (err) {
        console.error('Calendar AI analysis failed:', err);
      }
    }

    const enriched = events.map((e) => ({ ...e, aiAnalysis: analysisByKey[e.key] || null }));
    res.json({ events: enriched, fetchedAt: calendarCache.fetchedAt || Date.now() });
  } catch (err) {
    console.error('Calendar route error, returning static fallback:', err);
    const fallback = getFallbackCalendarEvents();
    res.json({ events: fallback, fetchedAt: Date.now(), fallback: true });
  }
});

app.post('/api/news/analyze', costlyLimiter, async (req, res) => {
  if (!genai) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }
  const { url, title, description } = req.body || {};
  if (!url || !title) {
    return res.status(400).json({ error: 'url and title are required.' });
  }
  const lang = ['kh', 'en'].includes(req.body?.lang) ? req.body.lang : 'en';
  try {
    const result = await analyzeArticle({ url, title, description }, lang);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to analyze this article.' });
  }
});

app.get('/api/news', async (req, res) => {
  if (!NEWS_API_KEY) {
    return res.status(500).json({ error: 'NEWS_API_KEY is not configured on the server.' });
  }
  try {
    const articles = await fetchGoldSilverNews();
    res.json({ articles, fetchedAt: cache.fetchedAt });
  } catch (err) {
    // Serve stale cache rather than a hard failure if NewsAPI is down/rate-limited.
    if (cache.articles) {
      return res.json({ articles: cache.articles, fetchedAt: cache.fetchedAt, stale: true });
    }
    console.error(err);
    res.status(502).json({ error: 'Failed to fetch news.' });
  }
});

// ---------------------------------------------------------------------------
// PIP TRADING COACH (AI CHAT ENDPOINT)
// ---------------------------------------------------------------------------

const PIP_SYSTEM_PROMPT = `You are Pip, the official Trading Coach for GenZ Trader.
You were taught directly by GenZ Trader to help traders master financial markets, ICT (Inner Circle Trader) Smart Money Concepts (SMC), and algorithmic price delivery for Forex, Crypto, and Gold (XAU/USD).

CORE DIRECTIVES (CRITICAL):
1. BE CONCISE & TO THE POINT — DO NOT TALK TOO MUCH:
   - Keep all responses sharp, structured, and actionable.
   - Avoid long-winded essays, unnecessary filler, or bloated greetings.

2. NO LIVE PRICE FEED / NEVER INVENT FAKE GOLD DATA:
   - CRITICAL: You do NOT have real-time live market price feeds.
   - If the user asks for a trade signal, entry, or current Gold/XAUUSD price WITHOUT uploading a chart image:
     DO NOT invent fake prices, do NOT fabricate fake Gold signals out of nowhere.
     Instead, politely tell them in 1-2 sentences:
     "I do not have real-time live market data for Gold. Please upload or paste a screenshot of your chart (with visible price scale and timeframe), and I will run Pip's 5-Point ICT Audit and estimate a setup for you! 📊"
     (In Khmer: "ខ្ញុំមិនមានទិន្នន័យផ្សារផ្ទាល់ (Live Market Data) សម្រាប់ Gold នោះទេ។ សូម Upload ឬ Paste រូបភាព Chart របស់អ្នក (ដែលមានកម្រិតតម្លៃ និង Timeframe) ដើម្បីឱ្យខ្ញុំធ្វើការវិភាគ 5-Point ICT Audit និងប៉ាន់ស្មាន Signal ជូន! 📊")

3. 5-POINT ICT INSTITUTIONAL AUDIT & ESTIMATED SIGNAL (ONLY WHEN A CHART IMAGE IS ATTACHED):
   - When a user sends a chart screenshot, analyze the actual visible chart:
   - Read the actual asset pair and price scale from the user's uploaded image. Do NOT default to Gold unless the chart is clearly XAUUSD!

   📊 **Pip's 5-Point ICT Audit:**
   1. 💧 **Liquidity Sweep**: [Pass / Fail — e.g. Asian Low swept / Buy-side liquidity raided]
   2. ⚡ **Market Structure Shift (MSS)**: [Pass / Fail — e.g. 15m Displacement with candle close]
   3. 📐 **PD Array (FVG / OB)**: [Pass / Fail — e.g. Valid 15m Bullish FVG / Bearish Order Block]
   4. ⚖️ **Premium vs. Discount**: [Pass / Fail — e.g. Buying in Discount <50% / Selling in Premium >50%]
   5. ⏰ **Session & Killzone**: [Pass / Fail — e.g. Active London / NY AM Killzone (GMT+7)]
   🎯 **Setup Probability Score**: [e.g. 8.5/10 — High Probability]

   🎯 **Estimated Signal: [PAIR FROM CHART] [BUY / SELL]**
   📍 **Entry**: [Estimated entry price or zone read from chart]
   🛑 **Stop Loss (SL)**: [Invalidation level read from chart]
   🎯 **Take Profit (TP)**: [Target level(s), minimum 1:2 R:R]
   ⚠️ **Note**: Take your own risk. Always apply proper risk management.

   - If the user asks in Khmer, provide the same clean structure in natural Khmer:
   📊 **ការត្រួតពិនិត្យ 5-Point ICT Audit ដោយ Pip:**
   1. 💧 **Liquidity Sweep (ការបោសសម្អាតសាច់ប្រាក់)**: [ជាប់ / មិនទាន់]
   2. ⚡ **Market Structure Shift (MSS)**: [ជាប់ / មិនទាន់]
   3. 📐 **PD Array (FVG / OB)**: [ជាប់ / មិនទាន់]
   4. ⚖️ **Premium vs. Discount**: [ជាប់ / មិនទាន់]
   5. ⏰ **Session & Killzone**: [ជាប់ / មិនទាន់]
   🎯 **ពិន្ទុឱកាសជោគជ័យ**: [0-10]

   🎯 **សញ្ញាប៉ាន់ស្មាន (Estimated Signal): [PAIR FROM CHART] [BUY / SELL]**
   📍 **Entry**: [តម្លៃចូលប៉ាន់ស្មានផ្អែកលើ Chart]
   🛑 **Stop Loss (SL)**: [កម្រិតកាត់ខាត]
   🎯 **Take Profit (TP)**: [កម្រិតយកប្រាក់ចំណេញ]
   ⚠️ **ចំណាំ**: សូមគ្រប់គ្រងហានិភ័យដោយខ្លួនឯង (Take your own risk)!

4. GENERAL TRADING QUESTIONS:
   - Answer in 2-4 concise bullet points or 1 brief paragraph. No fluff.

5. SCOPE ENFORCEMENT:
   - Strictly trading and financial markets only. If completely off-topic, politely refuse in 1 short sentence:
     "In this chat, we strictly talk about trading and market analysis! Feel free to ask about ICT concepts or upload a chart for an estimated signal."
     (If in Khmer: "នៅក្នុងការជជែកនេះ យើងនិយាយតែអំពីការជួញដូរប៉ុណ្ណោះ! សូមសួរអំពីបច្ចេកទេសជួញដូរ ឬផ្ញើរូបភាព Chart មកពិនិត្យ!")

6. TIME & PRICE REFERENCE:
   - Session times in Cambodia Local Time (GMT+7 Phnom Penh):
     • Asian Range: 07:00 - 13:00 GMT+7
     • London Killzone: 14:00 - 17:00 GMT+7
     • New York AM Killzone: 19:00 - 22:00 GMT+7
     • London Close: 22:00 - 00:00 GMT+7
`;

app.post('/api/pip/chat', pipLimiter, async (req, res) => {
  if (!genai) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }

  const { history = [], prompt = '', image = null } = req.body || {};
  if (!prompt && !image) {
    return res.status(400).json({ error: 'prompt or image is required.' });
  }

  const imageMatch = image && typeof image === 'string'
    ? image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)
    : null;
  if (image && !imageMatch) {
    return res.status(400).json({ error: 'Upload a PNG, JPG, or WebP chart image.' });
  }
  if (imageMatch && imageMatch[2].length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'Chart images must be 6 MB or smaller.' });
  }

  let imageReservation = null;
  try {
    if (imageMatch) imageReservation = await reservePipImageSignal(req);
    const contents = [];

    // Prior conversation history (last 8 turns for bounded context)
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const msg of recent) {
      if (msg.sender === 'user' && msg.text) {
        contents.push({
          role: 'user',
          parts: [{ text: msg.text }],
        });
      } else if (msg.sender === 'bot' && msg.text) {
        contents.push({
          role: 'model',
          parts: [{ text: msg.text }],
        });
      }
    }

    // Current turn
    const currentParts = [];
    if (imageMatch) {
      currentParts.push({
        inlineData: {
          mimeType: imageMatch[1],
          data: imageMatch[2],
        },
      });
    }

    currentParts.push({ text: prompt || 'Please analyze this trading chart according to ICT concepts.' });
    contents.push({ role: 'user', parts: currentParts });

    const response = await genai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: PIP_SYSTEM_PROMPT,
        temperature: 0.5,
        maxOutputTokens: 800,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    if (!response.text) throw new Error('Pip could not generate a chart analysis. Please try again.');
    const reply = response.text;
    res.json({
      reply,
      ...(imageReservation ? { quota: {
        unlimited: Boolean(imageReservation.unlimited),
        planId: imageReservation.planId,
        limit: imageReservation.limit,
        used: imageReservation.used,
        remaining: imageReservation.remaining,
        resetsAt: imageReservation.resetsAt || null,
      } } : {}),
    });
  } catch (err) {
    if (imageReservation?.usageRef) {
      try { await releasePipImageSignal(imageReservation); }
      catch (releaseError) { console.error('Could not release Pip image signal quota:', releaseError); }
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message, ...(err.quota ? { quota: err.quota } : {}) });
    }
    console.error('Pip chat error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate response.' });
  }
});

app.listen(PORT, () => {
  console.log(`genztrader-news-api listening on port ${PORT}`);
});
