# Payment and subscription API

The Express API owns package prices, payment orders, provider verification,
and subscription activation. The React client only requests order creation
and checks payment status. Clients must not write to `payments`,
`subscriptions`, or protected user access fields.

Configure the API environment with `FIREBASE_SERVICE_ACCOUNT_JSON`,
`BAKONG_API_BASE_URL`, `BAKONG_API_TOKEN`, and `BAKONG_ACCOUNT_ID`. Optional
merchant settings are `BAKONG_MERCHANT_NAME` and `BAKONG_MERCHANT_CITY`.
Set `FRONTEND_ORIGIN` to the deployed site origin(s), and set the React
frontend's `VITE_NEWS_API_URL` to this API.

Package documents are initialized from server defaults on the first
`GET /api/packages`. They live at `packages/{packageId}` and provide the
price, features, and limits used for new orders. Each order snapshots its
package so catalog changes do not alter pending payments. Bakong integration
is isolated in `paymentProviders/bakong.js` behind create and verify methods.

Deploy Firestore rules and indexes from `genztrader-react`, then deploy the
Firebase Functions codebase. The `expireSubscriptions` scheduled function
marks pending orders expired and revokes expired access every 15 minutes.
Production Bakong verification requires valid credentials and a deployment
region accepted by Bakong.
