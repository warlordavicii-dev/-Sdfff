const jwt = require('jsonwebtoken');
const User = require('../models/User');

async function requireAuth(req, res, next) {
  const token = req.cookies.token;
  if (!token) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/login');
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user) {
      res.clearCookie('token');
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/login');
    }
    req.user = user;
    res.locals.user = user;
    next();
  } catch (err) {
    res.clearCookie('token');
    req.flash('error', 'Session expired. Please log in again.');
    return res.redirect('/login');
  }
}

// Attaches req.user if logged in, but does not block the route
async function attachUser(req, res, next) {
  const token = req.cookies.token;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.id);
    if (user) {
      req.user = user;
      res.locals.user = user;
    }
  } catch (err) {
    // ignore invalid token
  }
  next();
}

module.exports = { requireAuth, attachUser };
