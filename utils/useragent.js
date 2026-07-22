// A deliberately small, dependency-free parser — good enough to show
// "Chrome on Windows" in the login activity list without pulling in a full
// user-agent database.

function detectBrowser(ua) {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) return 'Chrome';
  if (/crios\//i.test(ua)) return 'Chrome';
  if (/fxios\//i.test(ua)) return 'Firefox';
  if (/firefox\//i.test(ua)) return 'Firefox';
  if (/safari\//i.test(ua) && /version\//i.test(ua)) return 'Safari';
  return 'a browser';
}

function detectOS(ua) {
  if (/windows/i.test(ua)) return 'Windows';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/android/i.test(ua)) return 'Android';
  if (/mac os x|macintosh/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'an unknown device';
}

function describe(userAgent) {
  if (!userAgent) return 'Unknown device';
  return `${detectBrowser(userAgent)} on ${detectOS(userAgent)}`;
}

module.exports = { describe };
