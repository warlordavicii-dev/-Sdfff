const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.get('/about', requireAuth, (req, res) => {
  res.render('about', { title: 'About' });
});

module.exports = router;
