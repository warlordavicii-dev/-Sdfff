const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const User = require('../models/User');

// We never use passport's own session (no serializeUser/deserializeUser) —
// this app issues its own JWT cookie right after a successful OAuth
// callback, the same way it does after a password login. Passport is only
// used here to run the OAuth handshake itself.

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${process.env.APP_URL}/auth/google/callback`,
        passReqToCallback: true
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
          const avatarUrl = profile.photos && profile.photos[0] ? profile.photos[0].value : null;

          const user = await User.findOrCreateFromOAuth({
            provider: 'google',
            providerId: profile.id,
            email,
            name: profile.displayName,
            avatarUrl,
            referredByCode: req.session.pendingReferralCode || null
          });
          req.session.pendingReferralCode = null;

          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    )
  );
}

if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  passport.use(
    new FacebookStrategy(
      {
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: `${process.env.APP_URL}/auth/facebook/callback`,
        profileFields: ['id', 'displayName', 'emails', 'photos'],
        passReqToCallback: true
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
          const avatarUrl = profile.photos && profile.photos[0] ? profile.photos[0].value : null;

          const user = await User.findOrCreateFromOAuth({
            provider: 'facebook',
            providerId: profile.id,
            email,
            name: profile.displayName,
            avatarUrl,
            referredByCode: req.session.pendingReferralCode || null
          });
          req.session.pendingReferralCode = null;

          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    )
  );
}

module.exports = passport;
