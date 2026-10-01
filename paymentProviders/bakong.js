import pkg from 'bakong-khqr';
import QRCode from 'qrcode';

const { BakongKHQR, khqrData, IndividualInfo } = pkg;
const API_BASE = process.env.BAKONG_API_BASE_URL;
const API_TOKEN = process.env.BAKONG_API_TOKEN;
const ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID;
const MERCHANT_NAME = process.env.BAKONG_MERCHANT_NAME || 'Sunhour Lim';
const MERCHANT_CITY = process.env.BAKONG_MERCHANT_CITY || 'Phnom Penh';
const QR_TTL_MS = 15 * 60 * 1000;

export const bakongReady = Boolean(API_BASE && API_TOKEN && ACCOUNT_ID);
export const bakongAccountId = ACCOUNT_ID;

export async function createProviderPayment({ paymentId, amount }) {
  const info = new IndividualInfo(ACCOUNT_ID, MERCHANT_NAME, MERCHANT_CITY, {
    currency: khqrData.currency.usd,
    amount,
    billNumber: `GZT-${paymentId}`.slice(0, 25),
    storeLabel: MERCHANT_NAME,
    terminalLabel: 'Web',
    expirationTimestamp: Date.now() + QR_TTL_MS,
  });
  const result = new BakongKHQR().generateIndividual(info);
  if (result.status.code !== 0) throw new Error(result.status.message || 'Could not create KHQR.');
  return {
    providerPaymentId: result.data.md5,
    qrImage: await QRCode.toDataURL(result.data.qr),
    expiresAt: Date.now() + QR_TTL_MS,
    recipient: ACCOUNT_ID,
  };
}

export async function verifyProviderPayment(providerPaymentId) {
  const response = await fetch(`${API_BASE}/v1/check_transaction_by_md5`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ md5: providerPaymentId }),
  });
  if (!response.ok) throw new Error(`Bakong verification returned ${response.status}`);
  return response.json();
}
