// Read-only indicator snapshots from the same TradingView scanner used by the site.
// No broker credentials, account access, synthetic candles, or executable quotes.
import { DEFAULT_LIMITS, validateAiSignal } from './risk.js';
export const MARKET_FEED_PAIRS = { XAUUSD: 'OANDA:XAUUSD' };
export const FEED_COLUMNS = [
  'close|15', 'RSI|15', 'MACD.macd|15', 'MACD.signal|15', 'EMA20|15', 'EMA50|15',
  'close|60', 'EMA20|60', 'EMA50|60', 'ATR|15', 'time|1', 'time|15',
  'Pivot.M.Classic.S1|15', 'Pivot.M.Classic.S2|15',
  'Pivot.M.Classic.R1|15', 'Pivot.M.Classic.R2|15',
];

export function parseMarketFeed(pair, row, now = Date.now()) {
  if (!MARKET_FEED_PAIRS[pair]) throw new Error(`Unsupported signal feed pair: ${pair}`);
  if (!Array.isArray(row) || row.length < FEED_COLUMNS.length
    || row.slice(0, 12).some(value => !Number.isFinite(value))) {
    throw new Error('Market feed returned incomplete price, indicator or timestamp data.');
  }
  const [price, rsi, macd, macdSignal, ema20, ema50, h1Price, h1Ema20, h1Ema50, atr, time1, time15] = row;
  const marketTimestamp = time1 * 1000;
  const candleTime = time15 * 1000;
  if ([price, ema20, ema50, h1Price, h1Ema20, h1Ema50, atr].some(value => value <= 0)
    || rsi < 0 || rsi > 100) throw new Error('Market feed returned invalid indicator values.');
  if (now - marketTimestamp > 180000 || marketTimestamp > now + 5000
    || candleTime > marketTimestamp || marketTimestamp - candleTime >= 15 * 60000) {
    throw new Error('Market feed is stale or closed. Waiting for a fresh market update.');
  }
  return {
    pair, source: 'TradingView scanner', ticker: MARKET_FEED_PAIRS[pair],
    price, rsi, macd, macdSignal, ema20, ema50, h1Price, h1Ema20, h1Ema50, atr,
    marketTimestamp, candleTime, fetchedAt: now, precision: 2,
    support: row.slice(12, 14).filter(value => Number.isFinite(value) && value > 0 && value < price),
    resistance: row.slice(14, 16).filter(value => Number.isFinite(value) && value > price),
  };
}

export function evaluateFeedConfluence(snapshot) {
  const s = snapshot;
  const up = s.price > s.ema20 && s.ema20 > s.ema50
    && s.h1Price > s.h1Ema20 && s.h1Ema20 > s.h1Ema50
    && s.macd > s.macdSignal && s.rsi > 54 && s.rsi < 70;
  const down = s.price < s.ema20 && s.ema20 < s.ema50
    && s.h1Price < s.h1Ema20 && s.h1Ema20 < s.h1Ema50
    && s.macd < s.macdSignal && s.rsi < 46 && s.rsi > 30;
  if (!up && !down) return { direction: 'hold', reason: 'M15/H1 trend, RSI and MACD do not confirm the same direction. Waiting for confluence.' };
  return { direction: up ? 'buy' : 'sell', reason: `M15/H1 EMA trend and MACD agree; RSI ${s.rsi.toFixed(1)} confirms momentum.` };
}

export function validateMarketFeedSignal(raw, snapshot, limits = DEFAULT_LIMITS) {
  const result = validateAiSignal(raw, { price: snapshot.price, atr: snapshot.atr, precision: snapshot.precision, limits });
  if (!result.ok || result.signal.direction === 'hold') return result;
  const signal = result.signal;
  if (signal.direction !== evaluateFeedConfluence(snapshot).direction) {
    return { ok: false, reason: 'Signal direction conflicts with the verified indicator trend.' };
  }
  const buy = signal.direction === 'buy';
  const stopLevels = buy ? snapshot.support : snapshot.resistance;
  const targetLevels = buy ? snapshot.resistance : snapshot.support;
  const stopSupported = stopLevels.some(level => buy
    ? signal.stopLoss < level && level < signal.entry
    : signal.stopLoss > level && level > signal.entry);
  const targetSupported = targetLevels.some(level => {
    const buffer = buy ? level - signal.takeProfit : signal.takeProfit - level;
    return buffer >= -0.01 && buffer <= snapshot.atr * 0.15;
  });
  if (!stopSupported || !targetSupported) return { ok: false, reason: 'Stop or target is not supported by the supplied market pivot levels.' };
  // Check rounded prices as these are the levels that will actually be published.
  const rounded = validateAiSignal(signal, { price: snapshot.price, atr: snapshot.atr, precision: snapshot.precision, limits });
  return rounded;
}

export async function fetchMarketFeed(pair, { fetchImpl = fetch, now = Date.now } = {}) {
  const ticker = MARKET_FEED_PAIRS[pair];
  if (!ticker) throw new Error(`Unsupported signal feed pair: ${pair}`);
  const response = await fetchImpl('https://scanner.tradingview.com/cfd/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: [ticker] }, columns: FEED_COLUMNS }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Market feed HTTP ${response.status}`);
  const data = await response.json();
  const row = data?.data?.find(item => item.s === ticker)?.d;
  return parseMarketFeed(pair, row, now());
}
