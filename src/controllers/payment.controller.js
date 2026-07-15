const supabase = require('../config/supabase');
const intasend = require('../services/intasend.service');
const ledgerService = require('../services/ledger.service');
const webhookService = require('../services/webhook.service');

/**
 * POST /api/mpesa/stk-push
 * Merchant-initiated deposit request. FXS Pay talks to IntaSend only —
 * IntaSend is the one holding the Safaricom/Daraja relationship.
 */
async function initiateStkPush(req, res) {
  const { phone, amount, accountReference, description } = req.body;

  if (!phone || !amount || amount <= 0) {
    return res.status(400).json({ error: 'phone and a positive amount are required' });
  }

  try {
    const wallet = await ledgerService.getOrCreateWallet(req.merchantId, 'KES');

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        merchant_id: req.merchantId,
        wallet_id: wallet.id,
        type: 'deposit',
        method: 'mpesa_stk',
        amount,
        currency: 'KES',
        status: 'pending',
        reference: accountReference || null,
        customer_phone: phone,
        description: description || 'FXS Pay deposit',
      })
      .select()
      .single();

    if (error) throw error;

    // api_ref carries our own transaction id, so the webhook can match back
    // to this exact row even if IntaSend's invoice id lookup were to miss.
    const result = await intasend.initiateStkPush({
      phone,
      amount,
      apiRef: transaction.id,
      narrative: description,
    });

    const invoiceId = result?.invoice?.invoice_id || result?.invoice?.id;

    await supabase
      .from('transactions')
      .update({ provider_reference: invoiceId })
      .eq('id', transaction.id);

    return res.status(202).json({
      message: 'STK push sent via IntaSend. Await customer confirmation.',
      transactionId: transaction.id,
      invoiceId,
    });
  } catch (err) {
    const message = err.response?.data?.detail || err.response?.data || err.message;
    return res.status(502).json({ error: `IntaSend request failed: ${JSON.stringify(message)}` });
  }
}

/**
 * POST /api/mpesa/webhook
 * Public — IntaSend calls this directly. Configure this URL in your
 * IntaSend dashboard under Settings -> Webhooks, along with a challenge
 * string that must match INTASEND_WEBHOOK_CHALLENGE.
 */
async function handleWebhook(req, res) {
  if (!intasend.verifyWebhookChallenge(req.body)) {
    return res.status(401).json({ error: 'Invalid webhook challenge' });
  }

  const event = intasend.parseInvoiceEvent(req.body);

  // Match primarily on our own transaction id (sent as api_ref), falling
  // back to IntaSend's invoice id for cases we didn't initiate ourselves
  // (e.g. a customer paying via an IntaSend-hosted payment link/Paybill).
  let transaction = null;

  if (event.apiRef) {
    const { data } = await supabase.from('transactions').select('*').eq('id', event.apiRef).maybeSingle();
    transaction = data;
  }
  if (!transaction && event.invoiceId) {
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('provider_reference', event.invoiceId)
      .maybeSingle();
    transaction = data;
  }

  if (!transaction) {
    console.error('IntaSend webhook for unrecognized transaction:', event);
    return res.status(200).json({ received: true });
  }

  // Idempotency — IntaSend may resend the same webhook.
  if (transaction.status === 'success' || transaction.status === 'failed') {
    return res.status(200).json({ received: true });
  }

  if (event.state === 'COMPLETE') {
    await supabase
      .from('transactions')
      .update({
        status: 'success',
        provider_reference: event.invoiceId,
        metadata: { provider: event.provider },
      })
      .eq('id', transaction.id);

    await ledgerService.creditWallet(transaction.wallet_id, transaction.id, transaction.amount);

    await webhookService.dispatchEvent(transaction.merchant_id, 'payment.success', {
      transactionId: transaction.id,
      amount: transaction.amount,
      currency: transaction.currency,
      invoiceId: event.invoiceId,
      receiptUrl: `${process.env.BASE_URL}/api/mpesa/receipt/${transaction.id}`,
    });
  } else if (event.state === 'FAILED') {
    await supabase
      .from('transactions')
      .update({ status: 'failed', metadata: { reason: event.failedReason } })
      .eq('id', transaction.id);

    await webhookService.dispatchEvent(transaction.merchant_id, 'payment.failed', {
      transactionId: transaction.id,
      reason: event.failedReason,
    });
  }
  // PENDING events just acknowledge without changing anything yet.

  return res.status(200).json({ received: true });
}

/**
 * GET /api/mpesa/status/:transactionId
 * Checks our own DB first; if still pending, polls IntaSend directly as a
 * fallback in case the webhook hasn't arrived yet.
 */
async function getStatus(req, res) {
  const { data: transaction, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', req.params.transactionId)
    .eq('merchant_id', req.merchantId)
    .maybeSingle();

  if (error || !transaction) return res.status(404).json({ error: 'Transaction not found' });

  if (transaction.status === 'pending' && transaction.provider_reference) {
    try {
      const live = await intasend.checkStatus(transaction.provider_reference);
      const event = intasend.parseInvoiceEvent(live);
      if (event.state === 'COMPLETE' && transaction.status !== 'success') {
        await ledgerService.creditWallet(transaction.wallet_id, transaction.id, transaction.amount);
        await supabase.from('transactions').update({ status: 'success' }).eq('id', transaction.id);
        transaction.status = 'success';
      }
    } catch (err) {
      // Non-fatal — just return the last known local status.
      console.error('IntaSend status poll failed:', err.message);
    }
  }

  return res.json({ transaction });
}

/**
 * GET /api/mpesa/receipt/:transactionId
 * Public, human-facing receipt link.
 */
async function getReceipt(req, res) {
  const { data: transaction } = await supabase
    .from('transactions')
    .select('id, amount, currency, status, method, provider_reference, created_at, merchants(business_name)')
    .eq('id', req.params.transactionId)
    .maybeSingle();

  if (!transaction) {
    return res.status(404).send('<h1>Receipt not found</h1>');
  }

  res.set('Content-Type', 'text/html');
  return res.send(`
    <html>
      <head><title>FXS Pay Receipt</title></head>
      <body style="font-family: sans-serif; max-width: 400px; margin: 40px auto; text-align: center;">
        <h2>${transaction.status === 'success' ? '✅ Payment Received' : 'Payment ' + transaction.status}</h2>
        <p style="font-size: 24px;">${transaction.currency} ${transaction.amount}</p>
        <p>Paid to: ${transaction.merchants?.business_name || 'Merchant'}</p>
        <p>Reference: ${transaction.provider_reference || '—'}</p>
        <p style="color: #666; font-size: 12px;">${new Date(transaction.created_at).toLocaleString()}</p>
      </body>
    </html>
  `);
}

module.exports = { initiateStkPush, handleWebhook, getStatus, getReceipt };
