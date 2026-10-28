// Pure technical-indicator helpers. Candles are { time, open, high, low, close, volume }
// ordered oldest -> newest. Nothing here touches the network.

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(prev);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// Wilder's RSI.
export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  const out = new Array(period).fill(null);
  const toRsi = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out.push(toRsi());
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out.push(toRsi());
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  if (!slowEma.length) return { macd: [], signal: [], histogram: [] };
  const line = values.map((_, i) => (fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null));
  const firstIdx = line.findIndex((v) => v != null);
  const compact = line.slice(firstIdx);
  const sig = ema(compact, signalPeriod);
  const signal = new Array(firstIdx).fill(null).concat(sig);
  const histogram = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { macd: line, signal, histogram };
}

// Wilder's ATR.
export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return [];
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period).fill(null);
  out.push(prev);
  for (let i = period + 1; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out.push(prev);
  }
  return out;
}

// Kaufman efficiency ratio over the last `period` closes: 1 = straight line, ~0 = pure chop.
export function efficiencyRatio(values, period = 20) {
  if (!Array.isArray(values) || values.length <= period) return null;
  const slice = values.slice(-(period + 1));
  const net = Math.abs(slice[slice.length - 1] - slice[0]);
  let path = 0;
  for (let i = 1; i < slice.length; i += 1) path += Math.abs(slice[i] - slice[i - 1]);
  return path === 0 ? 0 : net / path;
}

// Swing-high / swing-low clusters -> support & resistance levels around the current price.
export function supportResistance(candles, { lookback = 120, wing = 3, tolerance = 0 } = {}) {
  const recent = candles.slice(-lookback);
  const highs = [];
  const lows = [];
  for (let i = wing; i < recent.length - wing; i += 1) {
    const c = recent[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= wing; j += 1) {
      if (recent[i - j].high >= c.high || recent[i + j].high >= c.high) isHigh = false;
      if (recent[i - j].low <= c.low || recent[i + j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push(c.high);
    if (isLow) lows.push(c.low);
  }
  const price = candles[candles.length - 1]?.close;
  const cluster = (levels) => {
    const sorted = [...levels].sort((a, b) => a - b);
    const groups = [];
    for (const lvl of sorted) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(lvl - last.avg) <= tolerance) {
        last.sum += lvl; last.n += 1; last.avg = last.sum / last.n;
      } else {
        groups.push({ sum: lvl, n: 1, avg: lvl });
      }
    }
    return groups.map((g) => ({ level: g.avg, touches: g.n }));
  };
  const all = cluster([...highs, ...lows]);
  const resistance = all.filter((l) => l.level > price).sort((a, b) => a.level - b.level).slice(0, 3);
  const support = all.filter((l) => l.level <= price).sort((a, b) => b.level - a.level).slice(0, 3);
  return { support, resistance };
}

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

// Compact, JSON-friendly snapshot of one timeframe, used for both the UI and the AI prompt.
export function summarizeTimeframe(candles, { precision = 5 } = {}) {
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  const ema20 = last(ema(closes, 20));
  const ema50 = last(ema(closes, 50));
  const ema200 = candles.length >= 200 ? last(ema(closes, 200)) : null;
  const rsi14 = last(rsi(closes, 14));
  const m = macd(closes);
  const atrSeries = atr(candles, 14);
  const atr14 = last(atrSeries);
  const price = closes[closes.length - 1];
  const sr = supportResistance(candles, { tolerance: (atr14 || 0) * 0.5 });
  const er = efficiencyRatio(closes, 20);
  const r = (n) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(precision)));

  let trend = 'sideways';
  if (ema20 != null && ema50 != null) {
    if (price > ema20 && ema20 > ema50) trend = 'up';
    else if (price < ema20 && ema20 < ema50) trend = 'down';
  }

  return {
    price: r(price),
    ema20: r(ema20),
    ema50: r(ema50),
    ema200: r(ema200),
    rsi14: r(rsi14),
    macd: r(last(m.macd)),
    macdSignal: r(last(m.signal)),
    macdHistogram: r(last(m.histogram)),
    atr14: r(atr14),
    efficiencyRatio: er == null ? null : Number(er.toFixed(3)),
    trend,
    support: sr.support.map((s) => ({ level: r(s.level), touches: s.touches })),
    resistance: sr.resistance.map((s) => ({ level: r(s.level), touches: s.touches })),
    lastCandleTime: candles[candles.length - 1].time,
    volumeLast20Avg: Math.round(candles.slice(-20).reduce((a, c) => a + (c.volume || 0), 0) / 20),
  };
}

// Choppy when neither the entry timeframe nor the higher timeframe is directional.
export function isChoppy(summaries, threshold = 0.15) {
  const vals = ['M15', 'H1'].map((k) => summaries[k]?.efficiencyRatio).filter((v) => v != null);
  if (!vals.length) return false;
  return vals.every((v) => v < threshold);
}
