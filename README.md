# FXS Pay — Backend Core (Merchant + Wallet + M-Pesa via IntaSend)

This is the first slice of FXS Pay: merchant accounts, multi-currency wallets
with a double-entry ledger, M-Pesa deposits via **IntaSend** (not direct
Daraja), and signed outbound webhooks to merchants. Card processing, KYC
review, fraud scoring, and the admin dashboard are deliberately **not** in
this slice — see the note near the bottom on why.

**Why IntaSend instead of direct Daraja:** Safaricom still sits underneath
every M-Pesa transaction — that part can't be removed, M-Pesa is Safaricom's
own system — but with IntaSend, *they* hold the Paybill/Daraja relationship,
not you. You get M-Pesa (and card, if you want it later) through one API and
one webhook format, at the cost of an extra fee layer and less low-level
control than calling Daraja yourself.

## 1. Set up Supabase

1. Create a project at supabase.com.
2. Open the SQL editor and run `supabase/schema.sql` in full.
3. Grab your Project URL and `service_role` key (Settings → API) — the
   service role key bypasses RLS, which is correct here since all access
   control happens in this backend, not in Supabase directly.

## 2. Set up IntaSend

1. Create an account at intasend.com and get verified (this replaces
   registering your own Paybill/Till and getting Safaricom Daraja approval).
2. Grab your **Publishable Key** and **Secret Key** from the dashboard
   (Settings → API Keys). Use sandbox keys first — sandbox.intasend.com.
3. Under Settings → Webhooks, set your webhook URL to
   `https://your-render-app.onrender.com/api/mpesa/webhook` and set a
   **challenge** string — put the same string in `INTASEND_WEBHOOK_CHALLENGE`.
   This challenge is how the webhook handler confirms a call actually came
   from IntaSend and not an unauthenticated third party.

## 3. Configure environment

```bash
cp .env.example .env
```

Fill in:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET` — generate with `openssl rand -hex 32`
- `INTASEND_PUBLISHABLE_KEY`, `INTASEND_SECRET_KEY`, `INTASEND_WEBHOOK_CHALLENGE`
- `BASE_URL` — must be your real public Render URL once deployed (used to
  build receipt links)

## 4. Install & run locally

```bash
npm install
npm run dev
```

Health check: `GET http://localhost:4000/health`

Note: IntaSend's webhook still needs a public HTTPS URL to call back to, so
local STK push testing needs ngrok (or similar) pointed at your dev server —
same as any webhook-based integration would, IntaSend included.

## 5. Deploy to Render

- New Web Service → connect this repo
- Build command: `npm install`
- Start command: `npm start`
- Add all the `.env` values as Render environment variables
- Once deployed, update the webhook URL in your IntaSend dashboard to the
  real Render URL

## API surface in this slice

```
POST   /api/merchant/register
POST   /api/merchant/login
GET    /api/merchant/profile         (JWT)
PUT    /api/merchant/profile         (JWT)
POST   /api/merchant/api-key         (JWT)
DELETE /api/merchant/account         (JWT)

GET    /api/wallet                   (API key)
GET    /api/wallet/:currency/balance (API key)
POST   /api/wallet/transfer          (API key)

POST   /api/mpesa/stk-push           (API key)  — triggers STK push via IntaSend
GET    /api/mpesa/status/:id         (API key)  — checks DB, polls IntaSend if still pending
GET    /api/mpesa/receipt/:id        (public)   — human-facing receipt link
POST   /api/mpesa/webhook            (public)   — IntaSend calls this directly

POST   /api/webhook/endpoints        (API key)  — merchants register THEIR OWN webhook URLs
GET    /api/webhook/endpoints        (API key)
GET    /api/webhook/deliveries       (API key)
```

Two auth types are used on purpose:
- **JWT** — the merchant's own dashboard session (login-based)
- **API key** (`fxs_test_...` / `fxs_live_...`) — for merchant's own backend
  or a developer integrating against FXS Pay programmatically

There are two separate webhook layers here, easy to conflate: `/api/mpesa/webhook`
is IntaSend calling **your** FXS Pay backend; `webhook_endpoints` (registered
via `/api/webhook/endpoints`) is FXS Pay calling **merchants'** backends once
a payment is confirmed. FXS Pay sits in the middle of both.

## How a deposit flows end to end

1. Merchant (or their integration) calls `POST /api/mpesa/stk-push` with a
   customer phone number and amount.
2. FXS Pay creates a `pending` transaction, then calls IntaSend's Collection
   API — passing our own `transaction.id` as `api_ref` so we can match the
   webhook back to this exact row later, independent of IntaSend's own
   invoice id.
3. Customer gets the M-Pesa PIN prompt on their phone (IntaSend triggered it
   through their own Daraja relationship — this code never talks to
   Safaricom).
4. IntaSend calls `POST /api/mpesa/webhook` once the payment resolves. The
   handler verifies the `challenge`, matches the transaction by `api_ref`
   (falling back to `provider_reference`/invoice id), credits the merchant's
   wallet through the ledger, and fires FXS Pay's own webhook to the
   merchant.
5. `account_code` (assigned to every merchant at registration) still exists
   for future use — e.g. an IntaSend-hosted payment link or checkout page
   where a customer pays without your code initiating anything first.

## Why cards, full KYC verification, and AML aren't here yet

- **Cards**: IntaSend already supports card collection alongside M-Pesa, so
  this is now mostly a matter of calling their Checkout API with a card
  option enabled rather than a separate integration — a good next slice.
- **KYC verification / AML**: this repo has the *data collection* plumbing
  (`merchant_kyc_documents` table, status workflow) but actual identity
  verification and AML compliance require either a licensed KYC provider
  (e.g. Smile Identity, common in Kenya) or manual human review — not
  something to fake with code.
- **Holding customer wallet balances at scale**: operating this as a real
  money-transmission business in Kenya requires a Central Bank of Kenya PSP
  license (or a partnership with an already-licensed entity, which is
  effectively what routing through IntaSend gives you for the M-Pesa piece).
  The ledger code here is correct and safe to build on, but launching it
  live with real customer funds beyond what your IntaSend relationship
  covers is a legal/licensing step, not a coding one.

## Ledger design note

`wallets.balance` is a cache — the real source of truth is `ledger_entries`,
and every balance change goes through the `apply_ledger_entry` Postgres
function so debits/credits and balance updates happen atomically (no race
condition between two withdrawals hitting the same wallet at once). If you
ever need to reconcile, sum `ledger_entries` per wallet and it must always
match `wallets.balance`.
