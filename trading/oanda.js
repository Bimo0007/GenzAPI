// Thin OANDA v20 REST client. Keys stay on the server (env vars only).
//
// Retry policy: GETs retry on 429 / 5xx / network errors with backoff. POST/PUT never auto-retry —
// a retried order after an ambiguous failure is how duplicate positions happen. Callers must
// reconcile through clientExtensions ids instead (see getOrderByClientId).

const HOSTS = {
  live: 'https://api-fxtrade.oanda.com',
  practice: 'https://api-fxpractice.oanda.com',
};

export const TRADING_PAIRS = {
  XAUUSD: 'XAU_USD',
  XAGUSD: 'XAG_USD',
  EURUSD: 'EUR_USD',
  GBPUSD: 'GBP_USD',
  USDJPY: 'USD_JPY',
  AUDUSD: 'AUD_USD',
  USDCAD: 'USD_CAD',
};

export const TIMEFRAMES = { M5: 'M5', M15: 'M15', H1: 'H1', H4: 'H4' };

export class OandaError extends Error {
  constructor(message, { status = 0, code = null, retryable = false, ambiguous = false, retryAfter = null } = {}) {
    super(message);
    this.name = 'OandaError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.ambiguous = ambiguous; // true => we don't know whether OANDA processed the request
    this.retryAfter = retryAfter;
  }
}

export function oandaConfig() {
  const env = String(process.env.OANDA_ENV || 'live').toLowerCase();
  return {
    apiKey: process.env.OANDA_API_KEY || '',
    accountId: process.env.OANDA_ACCOUNT_ID || '',
    env,
    host: HOSTS[env] || HOSTS.live,
  };
}

export function oandaReady() {
  const c = oandaConfig();
  return Boolean(c.apiKey && c.accountId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, { body, timeoutMs = 10_000, retries = method === 'GET' ? 2 : 0 } = {}) {
  const cfg = oandaConfig();
  if (!cfg.apiKey || !cfg.accountId) throw new OandaError('OANDA is not configured on the server.', { status: 503 });

  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.host}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Datetime-Format': 'UNIX',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

      if (res.ok || (json && (json.orderFillTransaction || json.orderCancelTransaction || json.orderRejectTransaction))) {
        return json ?? {};
      }

      const message = json?.errorMessage || json?.rejectReason || `OANDA responded ${res.status}`;
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        attempt += 1;
        await sleep((retryAfter ? retryAfter * 1000 : 400 * 2 ** attempt));
        continue;
      }
      throw new OandaError(message, {
        status: res.status,
        code: json?.errorCode || null,
        retryable,
        // 5xx on a write may or may not have been applied; 429 and 4xx definitely were not.
        ambiguous: method !== 'GET' && res.status >= 500,
        retryAfter,
      });
    } catch (err) {
      if (err instanceof OandaError) throw err;
      const timedOut = err?.name === 'AbortError';
      if (method === 'GET' && attempt < retries) {
        attempt += 1;
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new OandaError(timedOut ? 'OANDA request timed out.' : `OANDA network error: ${err?.message || err}`, {
        status: 504,
        retryable: true,
        ambiguous: method !== 'GET',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

const acct = () => `/v3/accounts/${oandaConfig().accountId}`;

export async function getAccountSummary() {
  const { account } = await request('GET', `${acct()}/summary`);
  return {
    currency: account.currency,
    balance: Number(account.balance),
    nav: Number(account.NAV),
    unrealizedPL: Number(account.unrealizedPL),
    marginAvailable: Number(account.marginAvailable),
    openTradeCount: Number(account.openTradeCount),
  };
}

const instrumentCache = new Map();
export async function getInstrument(instrument) {
  const hit = instrumentCache.get(instrument);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.value;
  const { instruments } = await request('GET', `${acct()}/instruments?instruments=${instrument}`);
  const i = instruments?.[0];
  if (!i) throw new OandaError(`Instrument ${instrument} is not available on this account.`, { status: 404 });
  const value = {
    name: i.name,
    displayPrecision: Number(i.displayPrecision),
    pipSize: 10 ** Number(i.pipLocation),
    unitsPrecision: Number(i.tradeUnitsPrecision),
    minUnits: Number(i.minimumTradeSize),
    maxUnits: Number(i.maximumOrderUnits),
    marginRate: Number(i.marginRate),
  };
  instrumentCache.set(instrument, { at: Date.now(), value });
  return value;
}

// Mid-price candles. `complete:false` last candle is dropped so indicators only use closed bars.
export async function getCandles(instrument, granularity, count = 250, { includeIncomplete = false } = {}) {
  const qs = `?price=M&granularity=${granularity}&count=${count}`;
  const { candles } = await request('GET', `/v3/instruments/${instrument}/candles${qs}`);
  return (candles || [])
    .filter((c) => (includeIncomplete || c.complete) && c.mid)
    .map((c) => ({
      time: Number(c.time) * 1000,
      open: Number(c.mid.o),
      high: Number(c.mid.h),
      low: Number(c.mid.l),
      close: Number(c.mid.c),
      volume: Number(c.volume),
    }));
}

export async function getPricing(instrument) {
  const { prices } = await request('GET', `${acct()}/pricing?instruments=${instrument}&includeHomeConversions=true`);
  const p = prices?.[0];
  if (!p || !p.bids?.length || !p.asks?.length) throw new OandaError('No live quote returned.', { status: 502, retryable: true });
  return {
    instrument: p.instrument,
    bid: Number(p.bids[0].price),
    ask: Number(p.asks[0].price),
    tradeable: Boolean(p.tradeable),
    time: Number(p.time) * 1000,
    // Account-currency value of one unit of price movement (per unit of the instrument).
    lossFactor: Number(p.quoteHomeConversionFactors?.negativeUnits) || null,
    homeConversions: p.homeConversions || [],
  };
}

export async function getOpenTrades() {
  const { trades } = await request('GET', `${acct()}/openTrades`);
  return trades || [];
}

export async function getTradesByIds(ids) {
  if (!ids.length) return [];
  const { trades } = await request('GET', `${acct()}/trades?state=ALL&ids=${ids.join(',')}&count=500`);
  return trades || [];
}

// Market order with SL + TP attached at fill. FOK so a fill is all-or-nothing; the caller still
// compares filled vs requested units in case the broker reports otherwise.
export async function placeMarketOrder({ instrument, units, stopLoss, takeProfit, clientId, precision, tag = 'genz-ai' }) {
  const order = {
    type: 'MARKET',
    instrument,
    units: String(units),
    timeInForce: 'FOK',
    positionFill: 'DEFAULT',
    clientExtensions: { id: clientId, tag, comment: 'GenZ Trader AI' },
    tradeClientExtensions: { id: clientId, tag, comment: 'GenZ Trader AI' },
    stopLossOnFill: { price: stopLoss.toFixed(precision), timeInForce: 'GTC' },
    takeProfitOnFill: { price: takeProfit.toFixed(precision), timeInForce: 'GTC' },
  };
  const res = await request('POST', `${acct()}/orders`, { body: { order }, timeoutMs: 15_000 });

  if (res.orderFillTransaction) {
    const f = res.orderFillTransaction;
    const requested = Math.abs(Number(units));
    const filled = Math.abs(Number(f.units));
    return {
      status: filled + 1e-9 < requested ? 'partial' : 'filled',
      tradeId: f.tradeOpened?.tradeID || null,
      filledUnits: filled,
      requestedUnits: requested,
      fillPrice: Number(f.price),
      transactionId: f.id,
    };
  }
  if (res.orderCancelTransaction || res.orderRejectTransaction) {
    const t = res.orderCancelTransaction || res.orderRejectTransaction;
    return { status: 'rejected', reason: t.reason || t.rejectReason || 'Order was not filled.', transactionId: t.id };
  }
  throw new OandaError('OANDA returned an unrecognised order response.', { status: 502, ambiguous: true });
}

// Look an order up by the client id we assigned, to settle "did that timed-out order go through?".
export async function getOrderByClientId(clientId) {
  try {
    const { order } = await request('GET', `${acct()}/orders/@${encodeURIComponent(clientId)}`, { retries: 1 });
    return order || null;
  } catch (err) {
    if (err instanceof OandaError && err.status === 404) return null;
    throw err;
  }
}
