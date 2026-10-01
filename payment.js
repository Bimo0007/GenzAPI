import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb, firebaseAdminReady, verifyIdToken } from './firebaseAdmin.js';
import { bakongAccountId, bakongReady, createProviderPayment, verifyProviderPayment } from './paymentProviders/bakong.js';

// The server owns prices, features, and limits. These IDs are the stable
// identifiers used by the UI; never accept price/permissions from a client.
export const PACKAGE_CATALOG = {
  starter: { name: 'Starter', monthly: 19.99, yearly: 199, features: ['vip_signals', 'academy_basic'], limits: { pipCoach: 10, pipImageSignals: 4, signals: 30 } },
  pro: { name: 'Pro', monthly: 29.99, yearly: 299, features: ['vip_signals', 'academy_basic', 'pip_coach', 'backtesting'], limits: { pipCoach: 100, pipImageSignals: 12, signals: 100 } },
  elite: { name: 'Elite', monthly: 79, yearly: 790, features: ['vip_signals', 'academy_basic', 'pip_coach', 'backtesting', 'advanced_academy', 'priority_support'], limits: { pipCoach: -1, pipImageSignals: 20, signals: -1 } },
};

async function loadPackages() {
  const packages = {};
  for (const [id, defaults] of Object.entries(PACKAGE_CATALOG)) {
    const ref = adminDb.collection('packages').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      await ref.set({ packageId: id, name: defaults.name, prices: { monthly: defaults.monthly, yearly: defaults.yearly },
        currency: 'USD', durations: { monthly: 1, yearly: 12 }, features: defaults.features, limits: defaults.limits, active: true });
      packages[id] = { packageId: id, name: defaults.name, prices: { monthly: defaults.monthly, yearly: defaults.yearly },
        currency: 'USD', durations: { monthly: 1, yearly: 12 }, features: defaults.features, limits: defaults.limits, active: true };
    } else {
      const stored = snapshot.data();
      const limits = {
        ...defaults.limits,
        ...(stored.limits || {}),
        pipImageSignals: defaults.limits.pipImageSignals,
      };
      if (stored.limits?.pipImageSignals !== limits.pipImageSignals) {
        await ref.set({ limits }, { merge: true });
      }
      packages[id] = { ...stored, limits };
    }
  }
  return packages;
}

async function requireUid(req, res) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }
  try { return await verifyIdToken(value.slice(7)); }
  catch { res.status(401).json({ error: 'Invalid or expired auth token.' }); return null; }
}

function addPeriod(date, months) {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

export function registerPaymentRoutes(app) {
  app.get('/api/packages', async (_req, res) => {
    if (!firebaseAdminReady) return res.status(503).json({ error: 'Package catalog is not configured.' });
    try {
      const packages = await loadPackages();
      res.json({ packages: Object.entries(packages).filter(([, p]) => p.active).map(([id, p]) => ({
        id, name: p.name, currency: p.currency, billing: {
          monthly: { amount: p.prices.monthly, period: 'monthly' },
          yearly: { amount: p.prices.yearly, period: 'yearly' },
        }, features: p.features, limits: p.limits,
      })) });
    } catch (error) { console.error('Package catalog failed:', error); res.status(502).json({ error: 'Could not load packages.' }); }
  });

  app.post('/api/payments', async (req, res) => {
    if (!firebaseAdminReady) return res.status(503).json({ error: 'Payments are not configured.' });
    if (!bakongReady) return res.status(503).json({ error: 'Bakong is not configured.' });
    const uid = await requireUid(req, res); if (!uid) return;
    const { packageId, billing } = req.body || {};
    if (!PACKAGE_CATALOG[packageId] || !['monthly', 'yearly'].includes(billing)) return res.status(400).json({ error: 'Choose a valid package and billing period.' });
    try {
      const packages = await loadPackages();
      const plan = packages[packageId];
      if (!plan?.active || plan.currency !== 'USD' || !Number.isFinite(plan.prices?.[billing]) || plan.prices[billing] <= 0
        || !Array.isArray(plan.features) || !plan.limits || typeof plan.limits !== 'object'
        || !Number.isInteger(plan.durations?.[billing]) || plan.durations[billing] < 1) {
        return res.status(400).json({ error: 'This package is unavailable.' });
      }
      const user = await adminDb.collection('users').doc(uid).get();
      if (!user.exists) return res.status(404).json({ error: 'User profile not found.' });
      const paymentRef = adminDb.collection('payments').doc();
      const amount = plan.prices[billing];
      const providerPayment = await createProviderPayment({ paymentId: paymentRef.id, amount });
      const expiresAt = Timestamp.fromMillis(providerPayment.expiresAt);
      await paymentRef.create({
        userId: uid, packageId, packageName: plan.name, packageFeatures: plan.features,
        packageLimits: plan.limits, durationMonths: plan.durations?.[billing] || (billing === 'yearly' ? 12 : 1),
        billing, amount, currency: plan.currency || 'USD',
        paymentStatus: 'pending', provider: 'bakong', providerPaymentId: providerPayment.providerPaymentId,
        createdAt: FieldValue.serverTimestamp(), expiresAt,
      });
      res.status(201).json({ paymentId: paymentRef.id, qrImage: providerPayment.qrImage,
        amount, currency: 'USD', packageId, packageName: plan.name, expiresAt: expiresAt.toMillis(),
        recipient: providerPayment.recipient });
    } catch (error) { console.error('Payment create failed:', error); res.status(502).json({ error: 'Could not create payment.' }); }
  });

  app.post('/api/payments/:paymentId/verify', async (req, res) => {
    if (!firebaseAdminReady || !bakongReady) return res.status(503).json({ error: 'Payments are not configured.' });
    const uid = await requireUid(req, res); if (!uid) return;
    const ref = adminDb.collection('payments').doc(req.params.paymentId);
    try {
      const payment = await ref.get();
      if (!payment.exists || payment.data().userId !== uid) return res.status(404).json({ error: 'Payment not found.' });
      const order = payment.data();
      if (order.paymentStatus === 'paid') return res.json({ status: 'paid' });
      if (order.paymentStatus !== 'pending') return res.json({ status: order.paymentStatus, reason: order.failureReason || null });
      if (order.expiresAt.toMillis() <= Date.now()) {
        await ref.update({ paymentStatus: 'expired', updatedAt: FieldValue.serverTimestamp() });
        return res.json({ status: 'expired' });
      }
      const result = await verifyProviderPayment(order.providerPaymentId);
      if (result.responseCode !== 0 || !result.data) return res.json({ status: 'pending' });
      const transaction = result.data;
      const paidAmount = Number(transaction.amount);
      const currency = String(transaction.currency || '').toUpperCase();
      let failureReason = null;
      if (transaction.toAccountId !== bakongAccountId) failureReason = 'recipient_mismatch';
      else if (!Number.isFinite(paidAmount) || paidAmount !== order.amount) failureReason = 'amount_mismatch';
      else if (currency !== order.currency) failureReason = 'currency_mismatch';
      if (failureReason) {
        await ref.update({ paymentStatus: 'failed', failureReason, updatedAt: FieldValue.serverTimestamp() });
        return res.json({ status: 'failed', reason: failureReason });
      }
      const transactionId = transaction.hash || transaction.transactionId || order.providerPaymentId;
      const startDate = new Date();
      const expiryDate = addPeriod(startDate, order.durationMonths);
      const subscriptionRef = adminDb.collection('subscriptions').doc(uid);
      const transactionRef = adminDb.collection('processedPaymentTransactions').doc(transactionId);
      await adminDb.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (fresh.data()?.paymentStatus === 'paid') return;
        if (fresh.data()?.paymentStatus !== 'pending') throw new Error('Payment is no longer pending.');
        const used = await tx.get(transactionRef);
        if (used.exists) throw new Error('Transaction already used.');
        const subscription = {
          userId: uid, packageId: order.packageId, packageName: order.packageName,
          amountPaid: order.amount, paymentId: ref.id, paymentStatus: 'paid',
          startDate: Timestamp.fromDate(startDate), expiryDate: Timestamp.fromDate(expiryDate),
          features: order.packageFeatures, limits: order.packageLimits,
          usage: Object.fromEntries(Object.entries(order.packageLimits).map(([key]) => [key, 0])),
          status: 'active', updatedAt: FieldValue.serverTimestamp(),
        };
        tx.update(ref, { paymentStatus: 'paid', providerTransactionId: transactionId, paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        tx.create(transactionRef, { paymentId: ref.id, userId: uid, processedAt: FieldValue.serverTimestamp() });
        tx.set(subscriptionRef, subscription);
        tx.set(adminDb.collection('users').doc(uid), {
          plan: order.packageId, tier: 'vip', status: 'approved',
          activeSubscriptionId: uid, subscriptionExpiresAt: expiryDate.getTime(),
        }, { merge: true });
      });
      res.json({ status: 'paid' });
    } catch (error) {
      console.error('Payment verification failed:', error);
      res.status(502).json({ error: 'Could not verify payment right now.' });
    }
  });
}
