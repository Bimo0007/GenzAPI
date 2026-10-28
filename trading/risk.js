// Pure risk / validation logic. No network, no Firestore — everything here is unit-tested.

export const DEFAULT_LIMITS = {
  riskPct: 1,            // % of account balance risked per trade
  maxDailyLossPct: 3,    // stop trading for the day once realised+open loss reaches this % of start-of-day balance
  maxOpenTrades: 3,
  minRr: 2,              // minimum reward:risk
  minConfidence: 70,     // AI confidence floor (0-100)
  minSlAtr: 0.5,         // stop distance bounds, in multiples of M15 ATR
  maxSlAtr: 4,
  maxEntryDriftAtr: 0.5, // live price may not wander further than this from the signal entry
  maxSpreadAtr: 0.25,    // spread must be below this fraction of M15 ATR
  signalTtlSec: 120,
};

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

export function round(value, precision) {
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}

// Validate the raw AI JSON. Returns { ok:true, signal } or { ok:false, reason }.
// `hold` is a valid answer; it is returned as { ok:true, signal:{direction:'hold', ...} }.
export function validateAiSignal(raw, ctx) {
  const { price, atr, precision, limits = DEFAULT_LIMITS } = ctx;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'AI response was not a JSON object.' };

  const direction = String(raw.direction || '').toLowerCase().trim();
  if (!['buy', 'sell', 'hold'].includes(direction)) return { ok: false, reason: `Invalid direction "${raw.direction}".` };

  const confidence = num(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return { ok: false, reason: 'Confidence must be a number from 0 to 100.' };

  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 400) : '';
  if (!reason) return { ok: false, reason: 'AI response is missing a reason.' };

  if (direction === 'hold') {
    return { ok: true, signal: { direction: 'hold', confidence: Math.round(confidence), reason } };
  }

  if (confidence < limits.minConfidence) {
    return { ok: true, signal: { direction: 'hold', confidence: Math.round(confidence), reason: `Confidence ${Math.round(confidence)}% is below the ${limits.minConfidence}% minimum. ${reason}` } };
  }

  const entry = num(raw.entry);
  const sl = num(raw.stopLoss);
  const tp = num(raw.takeProfit);
  if (![entry, sl, tp].every((v) => Number.isFinite(v) && v > 0)) return { ok: false, reason: 'Entry, stop-loss and take-profit must be positive numbers.' };

  const isBuy = direction === 'buy';
  if (isBuy && !(sl < entry && entry < tp)) return { ok: false, reason: 'BUY needs stop-loss < entry < take-profit.' };
  if (!isBuy && !(tp < entry && entry < sl)) return { ok: false, reason: 'SELL needs take-profit < entry < stop-loss.' };

  if (Math.abs(entry - price) > atr * limits.maxEntryDriftAtr) {
    return { ok: false, reason: `Entry ${entry} is too far from the live price ${price}.` };
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk < atr * limits.minSlAtr) return { ok: false, reason: 'Stop-loss is too tight for current volatility.' };
  if (risk > atr * limits.maxSlAtr) return { ok: false, reason: 'Stop-loss is too wide for current volatility.' };

  const rr = reward / risk;
  if (rr < limits.minRr) return { ok: false, reason: `Risk-reward 1:${rr.toFixed(2)} is below the 1:${limits.minRr} minimum.` };

  return {
    ok: true,
    signal: {
      direction,
      entry: round(entry, precision),
      stopLoss: round(sl, precision),
      takeProfit: round(tp, precision),
      riskReward: Number(rr.toFixed(2)), // always recomputed; the AI's own figure is ignored
      confidence: Math.round(confidence),
      reason,
    },
  };
}

// Position size in units from account risk. `lossPerUnitPerPrice` converts one price unit of
// movement on one unit of the instrument into account currency (1 for XAU_USD on a USD account).
export function computePositionUnits({ balance, riskPct, entry, stopLoss, lossPerUnitPerPrice, unitsPrecision = 0, minUnits = 1, maxUnits = Infinity }) {
  const riskAmount = balance * (riskPct / 100);
  const stopDistance = Math.abs(entry - stopLoss);
  if (!(balance > 0) || !(stopDistance > 0) || !(lossPerUnitPerPrice > 0)) return { ok: false, reason: 'Cannot size position: invalid balance, stop distance or conversion rate.' };
  const raw = riskAmount / (stopDistance * lossPerUnitPerPrice);
  const f = 10 ** unitsPrecision;
  const units = Math.floor(raw * f) / f;
  if (units < minUnits) return { ok: false, reason: `Risk budget ${riskAmount.toFixed(2)} is too small for this stop distance (min size ${minUnits}).` };
  return { ok: true, units: Math.min(units, maxUnits), riskAmount };
}

// Fresh check against the live quote at the moment of execution.
export function checkExecutionConditions({ signal, bid, ask, atr, tradeable, limits = DEFAULT_LIMITS }) {
  if (!tradeable) return { ok: false, reason: 'Market is closed or the instrument is not tradeable right now.' };
  const isBuy = signal.direction === 'buy';
  const ref = isBuy ? ask : bid;
  const spread = ask - bid;
  if (spread > atr * limits.maxSpreadAtr) return { ok: false, reason: 'Spread is too wide to trade safely right now.' };
  if (Math.abs(ref - signal.entry) > atr * limits.maxEntryDriftAtr) return { ok: false, reason: 'Price has moved away from the signal entry. Re-run the analysis.' };
  if (isBuy && !(signal.stopLoss < ref && ref < signal.takeProfit)) return { ok: false, reason: 'Price is already beyond the stop-loss or take-profit. Re-run the analysis.' };
  if (!isBuy && !(signal.takeProfit < ref && ref < signal.stopLoss)) return { ok: false, reason: 'Price is already beyond the stop-loss or take-profit. Re-run the analysis.' };
  const rr = Math.abs(signal.takeProfit - ref) / Math.abs(ref - signal.stopLoss);
  if (rr < limits.minRr) return { ok: false, reason: `Risk-reward at the live price is 1:${rr.toFixed(2)}, below the 1:${limits.minRr} minimum.` };
  return { ok: true, refPrice: ref, rr: Number(rr.toFixed(2)) };
}

// Daily loss lock + open-trade cap. `dayPnl` = realised PnL today + unrealised PnL of open AI trades.
export function checkAccountLimits({ startBalance, dayPnl, openTrades, locked, limits = DEFAULT_LIMITS }) {
  const lossLimit = startBalance * (limits.maxDailyLossPct / 100);
  if (locked) return { ok: false, lockDay: false, reason: 'Daily loss limit already reached. Trading is stopped until the next day.' };
  if (dayPnl <= -lossLimit) return { ok: false, lockDay: true, reason: `Daily loss limit (${limits.maxDailyLossPct}%) reached. Trading is stopped for the day.` };
  if (openTrades >= limits.maxOpenTrades) return { ok: false, lockDay: false, reason: `Max open trades (${limits.maxOpenTrades}) reached.` };
  return { ok: true, lossLimit, remainingLossBudget: lossLimit + dayPnl };
}

export function classifyOutcome(realizedPl, riskAmount) {
  const eps = Math.max(0.01, (riskAmount || 0) * 0.02);
  if (realizedPl > eps) return 'win';
  if (realizedPl < -eps) return 'loss';
  return 'breakeven';
}

export function pipsBetween(open, close, direction, pipSize) {
  const diff = direction === 'buy' ? close - open : open - close;
  return Number((diff / pipSize).toFixed(1));
}
