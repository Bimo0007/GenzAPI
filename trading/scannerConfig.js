export function getScannerReadiness({ firebaseReady, env = process.env }) {
  const enabled = !['false', '0'].includes(String(env.AI_SCANNER_ENABLED ?? 'true').toLowerCase());
  const missing = [];
  if (!firebaseReady) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  return { enabled, ready: enabled && !missing.length, missing, dataSource: 'TradingView scanner', signalOnly: true };
}
