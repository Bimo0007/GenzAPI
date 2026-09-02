// Serves gold OHLC bars for the site's own EMA + Order Block + ICT buy/sell
// signal panel (src/components/GoldSignalPanel.jsx) — proxied through here,
// not called directly from the browser, because it needs an API Ninjas key
// (X-Api-Key header) that can't be exposed client-side. Cached in-memory so
// every visitor doesn't count against the free tier's 100 req/hour cap —
// one shared fetch serves everyone for CACHE_TTL_MS.
const API_NINJAS_KEY = process.env.API_NINJAS_KEY;
const CACHE_TTL_MS = 5 * 60 * 1000; // API Ninjas' free tier is itself 15-min-delayed, so polling more often than this buys nothing

let cache = { period: null, bars: null, fetchedAt: 0 };

async function fetchGoldHistory(period) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 3 * 24 * 60 * 60; // 3 days of history — plenty for EMA(21) warm-up + recent order blocks
  const url = `https://api.api-ninjas.com/v1/goldpricehistorical?period=${period}&start=${start}&end=${now}`;
  const res = await fetch(url, { headers: { 'X-Api-Key': API_NINJAS_KEY } });
  if (!res.ok) throw new Error(`API Ninjas ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('Unexpected response shape');
  // Their response is most-recent-first; the chart/indicator math below
  // expects oldest -> newest, same convention as the rest of the site's bars.
  return raw
    .map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
    .sort((a, b) => a.time - b.time);
}

export function registerGoldSignalRoute(app) {
  app.get('/api/gold/history', async (req, res) => {
    if (!API_NINJAS_KEY) {
      return res.status(500).json({ error: 'API_NINJAS_KEY is not configured on the server.' });
    }
    const period = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].includes(req.query.period)
      ? req.query.period
      : '15m';

    const isFresh = cache.period === period && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
    if (isFresh) {
      return res.json({ bars: cache.bars, cached: true });
    }

    try {
      const bars = await fetchGoldHistory(period);
      cache = { period, bars, fetchedAt: Date.now() };
      res.json({ bars, cached: false });
    } catch (err) {
      // Serve stale cache rather than nothing if API Ninjas is briefly down/rate-limited.
      if (cache.bars && cache.period === period) {
        return res.json({ bars: cache.bars, cached: true, stale: true });
      }
      console.error('gold history fetch failed:', err);
      res.status(502).json({ error: 'Failed to fetch gold price history.', detail: err.message });
    }
  });
}
