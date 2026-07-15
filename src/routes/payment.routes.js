const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { requireMerchantAuth } = require('../middleware/auth');

// Merchant-authenticated (JWT dashboard session or API key)
router.post('/stk-push', requireMerchantAuth, paymentController.initiateStkPush);
router.get('/status/:transactionId', requireMerchantAuth, paymentController.getStatus);
router.get('/transactions', requireMerchantAuth, paymentController.listTransactions);

// Public — human-facing receipt link
router.get('/receipt/:transactionId', paymentController.getReceipt);

// Public — IntaSend calls this directly, no auth header will be present.
// Verified instead via the `challenge` field checked inside the controller.
router.post('/webhook', express.json(), paymentController.handleWebhook);

module.exports = router;
