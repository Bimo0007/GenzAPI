import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, macd, atr, efficiencyRatio, summarizeTimeframe, isChoppy } from './indicators.js';
import {
  DEFAULT_LIMITS, validateAiSignal, computePositionUnits, checkExecutionConditions,
  checkAccountLimits, classifyOutcome, pipsBetween,
} from './risk.js';

const trend = (n, start = 100, step = 0.5) => Array.from({ length: n }, (_, i) => {
  const c = start + i * step;
  return { time: i * 60000, open: c - 0.2, high: c + 0.4, low: c - 0.4, close: c, volume: 100 };
});

test('ema of constant series is constant', () => {
  const out = ema(Array(40).fill(10), 20);
  assert.equal(out[out.length - 1], 10);
});

test('rsi is 100 on a pure uptrend and low on a downtrend', () => {
  const up = Array.from({ length: 40 }, (_, i) => i);
  assert.equal(rsi(up).at(-1), 100);
  const down = Array.from({ length: 40 }, (_, i) => 100 - i);
  assert.ok(rsi(down).at(-1) < 5);
});

test('macd histogram positive in an accelerating uptrend', () => {
  const v = Array.from({ length: 80 }, (_, i) => 100 + i * i * 0.02);
  assert.ok(macd(v).histogram.at(-1) > 0);
});

test('atr matches constant range', () => {
  const c = Array.from({ length: 30 }, (_, i) => ({ time: i, open: 10, high: 11, low: 9, close: 10, volume: 1 }));
  assert.ok(Math.abs(atr(c).at(-1) - 2) < 1e-9);
});

test('efficiency ratio: trend ~1, zig-zag ~0', () => {
  assert.ok(efficiencyRatio(Array.from({ length: 30 }, (_, i) => i)) > 0.99);
  assert.ok(efficiencyRatio(Array.from({ length: 30 }, (_, i) => (i % 2 ? 1 : 0))) < 0.1);
});

test('summarizeTimeframe flags uptrend and chop', () => {
  const s = summarizeTimeframe(trend(250), { precision: 2 });
  assert.equal(s.trend, 'up');
  assert.ok(s.rsi14 > 70);
  assert.equal(isChoppy({ M15: { efficiencyRatio: 0.05 }, H1: { efficiencyRatio: 0.1 } }), true);
  assert.equal(isChoppy({ M15: { efficiencyRatio: 0.5 }, H1: { efficiencyRatio: 0.1 } }), false);
  assert.equal(summarizeTimeframe(trend(10)), null);
});

const ctx = { price: 2000, atr: 5, precision: 2, limits: DEFAULT_LIMITS };
const good = { direction: 'buy', entry: 2000, stopLoss: 1995, takeProfit: 2012, riskReward: 99, confidence: 80, reason: 'Trend up' };

test('valid buy passes and RR is recomputed, not trusted', () => {
  const r = validateAiSignal(good, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.signal.riskReward, 2.4);
});

test('hold is valid; low confidence downgrades to hold', () => {
  assert.equal(validateAiSignal({ direction: 'hold', confidence: 20, reason: 'chop' }, ctx).signal.direction, 'hold');
  assert.equal(validateAiSignal({ ...good, confidence: 50 }, ctx).signal.direction, 'hold');
});

test('rejects malformed / unsafe AI output', () => {
  assert.equal(validateAiSignal(null, ctx).ok, false);
  assert.equal(validateAiSignal({ ...good, direction: 'long' }, ctx).ok, false);
  assert.equal(validateAiSignal({ ...good, reason: '' }, ctx).ok, false);
  assert.equal(validateAiSignal({ ...good, stopLoss: 2001 }, ctx).ok, false);          // wrong geometry
  assert.equal(validateAiSignal({ ...good, takeProfit: 2008 }, ctx).ok, false);        // RR 1.6 < 2
  assert.equal(validateAiSignal({ ...good, stopLoss: 1999 }, ctx).ok, false);          // SL too tight
  assert.equal(validateAiSignal({ ...good, stopLoss: 1970, takeProfit: 2100 }, ctx).ok, false); // SL too wide
  assert.equal(validateAiSignal({ ...good, entry: 2020, stopLoss: 2015, takeProfit: 2032 }, ctx).ok, false); // far from price
  assert.equal(validateAiSignal({ ...good, entry: 'abc' }, ctx).ok, false);
  assert.equal(validateAiSignal({ ...good, confidence: 140 }, ctx).ok, false);
});

test('sell geometry', () => {
  const r = validateAiSignal({ direction: 'sell', entry: 2000, stopLoss: 2005, takeProfit: 1988, confidence: 75, reason: 'x' }, ctx);
  assert.equal(r.ok, true);
});

test('position sizing risks exactly riskPct', () => {
  const r = computePositionUnits({ balance: 10000, riskPct: 1, entry: 2000, stopLoss: 1995, lossPerUnitPerPrice: 1, unitsPrecision: 0, minUnits: 1 });
  assert.equal(r.units, 20);       // $100 risk / $5 stop
  assert.equal(r.riskAmount, 100);
  assert.equal(computePositionUnits({ balance: 10, riskPct: 1, entry: 2000, stopLoss: 1900, lossPerUnitPerPrice: 1, minUnits: 1 }).ok, false);
  assert.equal(computePositionUnits({ balance: 0, riskPct: 1, entry: 1, stopLoss: 0.5, lossPerUnitPerPrice: 1 }).ok, false);
});

test('execution conditions', () => {
  const sig = { direction: 'buy', entry: 2000, stopLoss: 1995, takeProfit: 2012 };
  assert.equal(checkExecutionConditions({ signal: sig, bid: 1999.9, ask: 2000.1, atr: 5, tradeable: true }).ok, true);
  assert.equal(checkExecutionConditions({ signal: sig, bid: 1999.9, ask: 2000.1, atr: 5, tradeable: false }).ok, false);
  assert.equal(checkExecutionConditions({ signal: sig, bid: 1990, ask: 1994, atr: 5, tradeable: true }).ok, false); // beyond SL
  assert.equal(checkExecutionConditions({ signal: sig, bid: 1998, ask: 2003, atr: 5, tradeable: true }).ok, false); // spread
  assert.equal(checkExecutionConditions({ signal: sig, bid: 2001.9, ask: 2002.1, atr: 5, tradeable: true }).ok, false); // RR drops under 2
});

test('daily loss lock and max open trades', () => {
  assert.equal(checkAccountLimits({ startBalance: 10000, dayPnl: -100, openTrades: 0, locked: false }).ok, true);
  const hit = checkAccountLimits({ startBalance: 10000, dayPnl: -300, openTrades: 0, locked: false });
  assert.equal(hit.ok, false); assert.equal(hit.lockDay, true);
  assert.equal(checkAccountLimits({ startBalance: 10000, dayPnl: 0, openTrades: 0, locked: true }).ok, false);
  assert.equal(checkAccountLimits({ startBalance: 10000, dayPnl: 0, openTrades: 3, locked: false }).ok, false);
});

test('outcome + pips', () => {
  assert.equal(classifyOutcome(50, 100), 'win');
  assert.equal(classifyOutcome(-100, 100), 'loss');
  assert.equal(classifyOutcome(0.5, 100), 'breakeven');
  assert.equal(pipsBetween(1.1, 1.102, 'buy', 0.0001), 20);
  assert.equal(pipsBetween(1.1, 1.102, 'sell', 0.0001), -20);
});
