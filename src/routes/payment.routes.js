const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { requireApiKey } = require('../middleware/auth');

// Merchant-authenticated
router.post('/stk-push', requireApiKey, paymentController.initiateStkPush);
router.get('/status/:transactionId', requireApiKey, paymentController.getStatus);

// Public — human-facing receipt link
router.get('/receipt/:transactionId', paymentController.getReceipt);

// Public — IntaSend calls this directly, no auth header will be present.
// Verified instead via the `challenge` field checked inside the controller.
router.post('/webhook', express.json(), paymentController.handleWebhook);

module.exports = router;
