import { getMessaging } from 'firebase-admin/messaging';
import { adminDb, firebaseAdminReady } from './firebaseAdmin.js';

const STATE_REF = () => adminDb.collection('notificationState').doc('latestNews');
const PAID_PLAN_NAMES = ['starter', 'pro', 'elite', 'vip'];
let watcherStarted = false;

function isPaidMember(profile = {}) {
  if (profile.role === 'admin' || profile.role === 'dev') return false;
  return [profile.plan, profile.tier, profile.subscription, profile.membership]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .some((plan) => PAID_PLAN_NAMES.some((paid) => plan === paid || plan.includes(paid)));
}

async function sendNewsPush(article) {
  const tokenSnapshot = await adminDb.collectionGroup('notificationTokens').get();
  const profiles = new Map();
  const recipientsByToken = new Map();

  await Promise.all(tokenSnapshot.docs.map(async (tokenDoc) => {
    const uid = tokenDoc.ref.parent.parent?.id;
    const token = tokenDoc.data().token;
    if (!uid || !token) return;

    let profileRead = profiles.get(uid);
    if (!profileRead) {
      profileRead = adminDb.collection('users').doc(uid).get();
      profiles.set(uid, profileRead);
    }
    const profileSnapshot = await profileRead;
    if (profileSnapshot.exists && isPaidMember(profileSnapshot.data())) {
      recipientsByToken.set(token, tokenDoc.ref);
    }
  }));

  const recipients = [...recipientsByToken.entries()];
  for (let start = 0; start < recipients.length; start += 500) {
    const batch = recipients.slice(start, start + 500);
    const result = await getMessaging().sendEachForMulticast({
      tokens: batch.map(([token]) => token),
      notification: {
        title: '📰 Breaking Market News',
        body: String(article.title || 'A new market story is available.').slice(0, 180),
      },
      data: { url: article.url },
      webpush: {
        notification: {
          icon: 'https://genztradermentorship.org/favicon.png',
          badge: 'https://genztradermentorship.org/favicon.png',
          tag: `news-${Buffer.from(article.url).toString('base64url').slice(0, 48)}`,
          renotify: true,
        },
        fcmOptions: { link: article.url },
      },
    });

    const cleanup = [];
    result.responses.forEach((response, index) => {
      const code = response.error?.code;
      if (!response.success && (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      )) {
        cleanup.push(batch[index][1].delete());
      }
    });
    await Promise.all(cleanup);
  }
  return recipients.length;
}

/** Poll from the always-on Railway process so news alerts work without an open browser. */
export function startNewsPushWatcher(intervalMs = 20 * 60 * 1000) {
  if (watcherStarted) return () => {};
  watcherStarted = true;
  if (!firebaseAdminReady) {
    console.warn('[NewsPush] Firebase Admin is not configured; background news push is disabled.');
    return () => {};
  }

  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const apiBase = process.env.NEWS_PUSH_FEED_URL || `http://127.0.0.1:${process.env.PORT || 3001}`;
      const response = await fetch(`${apiBase}/api/news`);
      if (!response.ok) throw new Error(`News feed returned HTTP ${response.status}.`);
      const feed = await response.json();
      const articles = feed.articles || [];
      const latest = articles.find((article) => article?.url && article?.title);
      if (!latest) return;

      const stateRef = STATE_REF();
      const state = await stateRef.get();
      if (!state.exists) {
        await stateRef.set({ url: latest.url, publishedAt: latest.publishedAt || null, checkedAt: Date.now() });
        console.log('[NewsPush] Saved current news as the initial baseline.');
        return;
      }
      if (state.data().url === latest.url) return;

      const recipientCount = await sendNewsPush(latest);
      await stateRef.set({ url: latest.url, publishedAt: latest.publishedAt || null, checkedAt: Date.now() });
      console.log(`[NewsPush] Alerted ${recipientCount} paid member devices about: ${latest.title}`);
    } catch (err) {
      console.error('[NewsPush] Background news check failed:', err.message || err);
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(poll, 5000);
  initialTimer.unref?.();
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
