// Twelve Data candle source for the public chart (read-only market data, no broker/account access).
// Used when OANDA isn't configured. Key stays on the server (TWELVEDATA_API_KEY).

const SYMBOLS = {
  XAUUSD: 'XAU/USD',
  XAGUSD: 'XAG/USD',
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
};

const INTERVALS = { M1: '1min', M5: '5min', M15: '15min', H1: '1h', H4: '4h', D: '1day' };

// Same pip sizes / precision OANDA reports, so the chart looks identical on either source.
const META = {
  XAUUSD: { displayPrecision: 3, pipSize: 0.01 },
  XAGUSD: { displayPrecision: 5, pipSize: 0.0001 },
  USDJPY: { displayPrecision: 3, pipSize: 0.01 },
};
const DEFAULT_META = { displayPrecision: 5, pipSize: 0.0001 };

export class TwelveDataError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'TwelveDataError';
    this.status = status;
  }
}

// Tolerate pasted whitespace, quotes or a "NAME=" prefix in the hosting dashboard.
function apiKey() {
  return String(process.env.TWELVEDATA_API_KEY || '')
    .trim()
    .replace(/^TWELVEDATA_API_KEY\s*=\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

export function twelveDataReady() {
  return Boolean(apiKey());
}

export function getMeta(pair) {
  return META[pair] || DEFAULT_META;
}

export async function getCandles(pair, tf, count = 300) {
  const symbol = SYMBOLS[pair];
  const interval = INTERVALS[tf];
  if (!symbol || !interval) throw new TwelveDataError('Unsupported pair or timeframe.', 400);

  const qs = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(count),
    timezone: 'UTC',
    order: 'ASC',
    apikey: apiKey(),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.twelvedata.com/time_series?${qs}`, { signal: ctrl.signal });
    const data = await res.json();
    if (data.status === 'error' || !Array.isArray(data.values)) {
      throw new TwelveDataError(data.message || 'Twelve Data returned no candles.', data.code === 429 ? 429 : 502);
    }
    return data.values.map((v) => ({
      time: Date.parse(`${v.datetime.replace(' ', 'T')}${v.datetime.length > 10 ? '' : 'T00:00:00'}Z`),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: Number(v.volume) || 0,
    }));
  } catch (err) {
    if (err instanceof TwelveDataError) throw err;
    throw new TwelveDataError(err.name === 'AbortError' ? 'Twelve Data timed out.' : 'Twelve Data request failed.');
  } finally {
    clearTimeout(timer);
  }
}
