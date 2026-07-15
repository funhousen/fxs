const axios = require('axios');

const BASE_URL =
  process.env.INTASEND_ENV === 'production'
    ? 'https://payment.intasend.com'
    : 'https://sandbox.intasend.com';

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.INTASEND_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Triggers an M-Pesa STK push via IntaSend's Collection API. IntaSend owns
 * the Safaricom/Daraja relationship on their side — this code never talks
 * to Safaricom directly.
 *
 * apiRef is how we tell our own transaction apart later: pass the merchant's
 * account_code (and/or a transaction id) so the webhook can route correctly
 * even if invoice matching alone isn't enough.
 */
async function initiateStkPush({ phone, amount, apiRef, narrative, email }) {
  const payload = {
    public_key: process.env.INTASEND_PUBLISHABLE_KEY,
    amount,
    phone_number: phone,
    api_ref: apiRef,
    narrative: narrative || 'FXS Pay payment',
    email: email || undefined,
    currency: 'KES',
  };

  const { data } = await axios.post(`${BASE_URL}/api/v1/payment/collection/`, payload, {
    headers: authHeaders(),
  });

  return data; // { invoice: { id, invoice_id, state, ... } }
}

/**
 * Polls IntaSend for the current state of an invoice. Useful as a fallback
 * if a webhook is delayed or missed.
 */
async function checkStatus(invoiceId) {
  const payload = {
    public_key: process.env.INTASEND_PUBLISHABLE_KEY,
    invoice_id: invoiceId,
  };

  const { data } = await axios.post(`${BASE_URL}/api/v1/payment/status/`, payload, {
    headers: authHeaders(),
  });

  return data;
}

/**
 * IntaSend webhooks include a "challenge" string you configure in your
 * IntaSend dashboard (Settings -> Webhooks). Verifying it confirms the call
 * actually came from IntaSend rather than an unauthenticated third party.
 */
function verifyWebhookChallenge(body) {
  return body?.challenge && body.challenge === process.env.INTASEND_WEBHOOK_CHALLENGE;
}

/**
 * Normalizes an IntaSend webhook/status payload into a shape the rest of
 * the app can use regardless of whether the money came in via STK push,
 * card, or IntaSend's own Paybill/checkout link.
 */
function parseInvoiceEvent(body) {
  const invoice = body.invoice || body;
  return {
    invoiceId: invoice.invoice_id || invoice.id,
    state: invoice.state, // PENDING, COMPLETE, FAILED
    amount: parseFloat(invoice.value || invoice.net_amount || 0),
    currency: invoice.currency || 'KES',
    apiRef: invoice.api_ref || null,
    provider: invoice.provider || 'M-PESA',
    failedReason: invoice.failed_reason || null,
  };
}

module.exports = { initiateStkPush, checkStatus, verifyWebhookChallenge, parseInvoiceEvent };
