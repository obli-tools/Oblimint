import rateLimit from 'express-rate-limit';

// Global API limiter — unauthenticated requests only (see Obliance: shared
// proxy IPs must not lock out signed-in users). Runs after the session.
export const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    !!req.session?.userId ||
    req.path === '/health' ||
    req.path === '/api/auth/me' ||
    // Setup wizard: its own limiter (setup.routes.ts), progress polled every 1.5 s.
    req.path.startsWith('/api/setup/') ||
    // Dedicated authLimiter (IP + username).
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/logout',
  message: {
    success: false,
    error: 'Too many requests, please try again later',
  },
});

// Sign-in second factor, keyed by IP.
export const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many verification attempts, please try again later',
  },
});

// Sign-in second factor, keyed by the pending ACCOUNT: 10 wrong codes / 15 min.
export const mfaAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.session?.pendingMfaUserId,
  keyGenerator: (req) => `mfa-user:${req.session?.pendingMfaUserId}`,
  message: {
    success: false,
    error: 'Too many verification attempts, please try again later',
  },
});

// Login: IP + username, failed attempts only.
export const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip ?? 'unknown';
    const username = (req.body as { username?: string })?.username?.toLowerCase?.() ?? '';
    return `${ip}:${username}`;
  },
  message: {
    success: false,
    error: 'Too many login attempts, please try again in 5 minutes',
  },
});

// Step-up proofs (current password / TOTP code on a factor change), keyed by
// the signed-in account: 10 failures / 15 min.
export const stepUpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `stepup-user:${req.session?.userId ?? req.ip}`,
  message: {
    success: false,
    error: 'Too many verification attempts, please try again later',
  },
});
