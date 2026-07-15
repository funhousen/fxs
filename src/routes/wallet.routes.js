const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');
const { requireApiKey } = require('../middleware/auth');

router.get('/', requireApiKey, walletController.listWallets);
router.get('/:currency/balance', requireApiKey, walletController.getBalance);
router.post('/transfer', requireApiKey, walletController.transfer);

module.exports = router;
