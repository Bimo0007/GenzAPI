import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarketFeed, evaluateFeedConfluence, validateMarketFeedSignal, fetchMarketFeed, FEED_COLUMNS } from './marketFeed.js';
import { getScannerReadiness } from './scannerConfig.js';

const now = Date.UTC(2026,10,10,8,2);
const row = () => [4200,58,3,1,4197,4195,4200,4195,4190,5,now/1000-60,Math.floor(now/900000)*900,4196,4190,4212,4220];
const snapshot = () => parseMarketFeed('XAUUSD',row(),now);
const candidate = () => ({direction:'buy',entry:4200,stopLoss:4195,takeProfit:4212,confidence:80,reason:'M15/H1 uptrend with RSI 58; stop below 4196 support, target 4212 pivot.'});

test('scanner requires Firebase and Gemini, never an OANDA account or API key', () => {
  const result=getScannerReadiness({firebaseReady:true,env:{GEMINI_API_KEY:'test'}});
  assert.equal(result.ready,true);
  assert.equal(result.signalOnly,true);
  assert.deepEqual(result.missing,[]);
  assert.deepEqual(getScannerReadiness({firebaseReady:false,env:{}}).missing,['FIREBASE_SERVICE_ACCOUNT_JSON','GEMINI_API_KEY']);
  assert.equal(getScannerReadiness({firebaseReady:true,env:{GEMINI_API_KEY:'test',AI_SCANNER_ENABLED:'false'}}).ready,false);
});

test('feed parses observed values and actual pivots, without manufacturing quotes or candles', () => {
  const s=snapshot();
  assert.equal(s.price,4200);
  assert.equal(s.atr,5);
  assert.equal(s.marketTimestamp,now-60000);
  assert.deepEqual(s.support,[4196,4190]);
  assert.equal(s.bid,undefined);
  assert.equal(s.candles,undefined);
  assert.equal(evaluateFeedConfluence(s).direction,'buy');
});

test('stale, future, inconsistent and incomplete feed data are rejected', () => {
  for (const change of [
    r=>{r[10]=(now-181000)/1000;},
    r=>{r[10]=(now+10000)/1000;},
    r=>{r[11]=now/1000+100;},
    r=>{r[9]=null;},
    r=>{r[0]=Infinity;},
    r=>{r[9]=0;},
    r=>{r[1]=101;},
  ]) { const r=row(); change(r); assert.throws(()=>parseMarketFeed('XAUUSD',r,now)); }
  assert.throws(()=>parseMarketFeed('BTCUSD',row(),now),/Unsupported/);
});

test('mixed timeframes and extended momentum produce hold instead of forced signals', () => {
  assert.equal(evaluateFeedConfluence({...snapshot(),h1Price:4180}).direction,'hold');
  assert.equal(evaluateFeedConfluence({...snapshot(),rsi:75}).direction,'hold');
  assert.equal(evaluateFeedConfluence({...snapshot(),macd:0}).direction,'hold');
});

test('BUY and SELL must match trend, actual pivots, ATR and minimum reward/risk', () => {
  const s=snapshot();
  assert.equal(validateMarketFeedSignal(candidate(),s).ok,true);
  assert.equal(validateMarketFeedSignal({...candidate(),takeProfit:4210},s).ok,false);
  assert.equal(validateMarketFeedSignal({...candidate(),takeProfit:4205},s).ok,false);
  assert.equal(validateMarketFeedSignal({...candidate(),stopLoss:4198},s).ok,false);
  assert.equal(validateMarketFeedSignal({...candidate(),entry:4210},s).ok,false);
  const down={...s,ema20:4203,ema50:4205,h1Ema20:4205,h1Ema50:4210,macd:0,macdSignal:1,rsi:42,support:[4188],resistance:[4204]};
  const sell={...candidate(),direction:'sell',stopLoss:4205,takeProfit:4188};
  assert.equal(validateMarketFeedSignal(sell,down).ok,true);
  assert.equal(validateMarketFeedSignal(sell,s).ok,false);
});

test('model confidence and malformed responses cannot bypass the validation gate', () => {
  assert.equal(validateMarketFeedSignal({...candidate(),confidence:20},snapshot()).signal.direction,'hold');
  assert.equal(validateMarketFeedSignal(null,snapshot()).ok,false);
  assert.equal(validateMarketFeedSignal({...candidate(),direction:'hold'},snapshot()).signal.direction,'hold');
});

test('fetch uses existing public scanner with no broker authentication and verifies the ticker', async () => {
  let requested;
  const result=await fetchMarketFeed('XAUUSD',{now:()=>now,fetchImpl:async(url,options)=>{
    requested={url,options};
    return {ok:true,json:async()=>({data:[{s:'OANDA:XAUUSD',d:row()}]})};
  }});
  assert.equal(result.price,4200);
  assert.equal(requested.options.headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(requested.options.body).columns,FEED_COLUMNS);
  await assert.rejects(fetchMarketFeed('XAUUSD',{now:()=>now,fetchImpl:async()=>({ok:false,status:429})}),/HTTP 429/);
  await assert.rejects(fetchMarketFeed('XAUUSD',{now:()=>now,fetchImpl:async()=>({ok:true,json:async()=>({data:[{s:'OTHER',d:row()}]})})}),/incomplete/);
});

test('signal-only AI pipeline works without broker credentials and refuses unverified levels', async () => {
  const { produceMarketFeedSignal } = await import('./routes.js');
  const valid=await produceMarketFeedSignal(snapshot(),{now:()=>now,requestAi:async()=>candidate()});
  assert.equal(valid.signal.direction,'buy');
  assert.equal(valid.signal.riskReward,2.4);
  const bad=await produceMarketFeedSignal(snapshot(),{now:()=>now,requestAi:async()=>({...candidate(),takeProfit:4300})});
  assert.equal(bad.signal.direction,'hold');
  assert.match(bad.signal.reason,/pivot/);
  let requested=false;
  const mixed=await produceMarketFeedSignal({...snapshot(),rsi:50},{now:()=>now,requestAi:async()=>{requested=true;return candidate();}});
  assert.equal(mixed.signal.direction,'hold');
  assert.equal(requested,false);
});

test('AI response is discarded if the observed market data expires during analysis', async () => {
  const { produceMarketFeedSignal } = await import('./routes.js');
  let clock=now;
  const result=await produceMarketFeedSignal(snapshot(),{now:()=>clock,requestAi:async()=>{clock+=181000;return candidate();}});
  assert.equal(result.signal.direction,'hold');
  assert.match(result.signal.reason,/expired/);
});
