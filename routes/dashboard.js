const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const Transaction = require('../models/Transaction');

router.get('/dashboard', requireAuth, async (req, res) => {
  const transactions = await Transaction.listForUser(req.user.id, 5);

  res.render('dashboard', {
    title: 'Home',
    transactions
  });
});

module.exports = router;
