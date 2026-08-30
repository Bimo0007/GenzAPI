import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Type } from '@google/genai';

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
app.use(
  cors({
    origin: FRONTEND_ORIGIN ? FRONTEND_ORIGIN.split(',').map((s) => s.trim()) : '*',
  })
);
app.use(express.json());

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

const LANGUAGE_NAME = { kh: 'Khmer', en: 'English', zh: 'Chinese (Simplified)' };

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

app.get('/api/calendar', async (req, res) => {
  if (!FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'FINNHUB_API_KEY is not configured on the server.' });
  }
  const lang = ['kh', 'en', 'zh'].includes(req.query.lang) ? req.query.lang : 'en';
  try {
    const events = await fetchEconomicCalendar();

    let analysisByKey = {};
    if (genai) {
      const highImpact = events.filter((e) => e.impact === 'high');
      try {
        analysisByKey = await generateCalendarAnalysis(lang, highImpact);
      } catch (err) {
        console.error('Calendar AI analysis failed:', err);
        // Base calendar still returns fine without the AI layer.
      }
    }

    const enriched = events.map((e) => ({ ...e, aiAnalysis: analysisByKey[e.key] || null }));
    res.json({ events: enriched, fetchedAt: calendarCache.fetchedAt });
  } catch (err) {
    if (calendarCache.events) {
      return res.json({ events: calendarCache.events, fetchedAt: calendarCache.fetchedAt, stale: true });
    }
    console.error(err);
    res.status(502).json({ error: 'Failed to fetch economic calendar.' });
  }
});

app.post('/api/news/analyze', async (req, res) => {
  if (!genai) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }
  const { url, title, description } = req.body || {};
  if (!url || !title) {
    return res.status(400).json({ error: 'url and title are required.' });
  }
  const lang = ['kh', 'en', 'zh'].includes(req.body?.lang) ? req.body.lang : 'en';
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

app.listen(PORT, () => {
  console.log(`genztrader-news-api listening on port ${PORT}`);
});
