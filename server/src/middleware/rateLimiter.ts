import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { isIP } from 'net';
import { normalizeIp } from '../utils/clientIp';

/** Full 8-group form of an IPv6 address (no zone, no IPv4 tail). */
function ipv6Groups(ip: string): string[] | null {
  const [head, tail, extra] = ip.split('::');
  if (extra !== undefined) return null;
  const left = head ? head.split(':') : [];
  const right = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (right.some((g) => g.includes('.')) || left.some((g) => g.includes('.'))) return null;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  return [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''));
}

/**
 * Rate-limit key of a client address: IPv4 as is, IPv6 by its /64 (one
 * subscriber holds a whole /64: keying the full address would give it 2^64
 * fresh buckets).
 */
export function ipKey(raw: string | undefined): string {
  const ip = normalizeIp(raw);
  if (isIP(ip) !== 6) return ip || 'unknown';
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

const reqIpKey = (req: Request): string => ipKey(req.ip);
const loginUsername = (req: Request): string => {
  const u = (req.body as { username?: unknown } | undefined)?.username;
  return typeof u === 'string' ? u.trim().toLowerCase().slice(0, 128) : '';
};

// Global API limiter — unauthenticated requests only (see Obliance: shared
// proxy IPs must not lock out signed-in users). Runs after the session.
export const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: reqIpKey,
  skip: (req) =>
    !!req.session?.userId ||
    req.path === '/health' ||
    // API keys: their own limiters (services/apiKeys/middleware.ts).
    req.path.startsWith('/api/v1/') || req.path === '/mcp' ||
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
  keyGenerator: reqIpKey,
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
const ipUserLoginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${reqIpKey(req)}:${loginUsername(req)}`,
  message: {
    success: false,
    error: 'Too many login attempts, please try again in 5 minutes',
  },
});

// Login: one address (IPv6 /64) across usernames — password spraying.
const ipLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `login-ip:${reqIpKey(req)}`,
  message: {
    success: false,
    error: 'Too many login attempts, please try again later',
  },
});

// Login: one username across addresses — distributed guessing of one account.
// High enough that its owner never meets it; a botnet gets 100 guesses per
// 15 min instead of an unlimited number.
const accountLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => loginUsername(req) === '',
  keyGenerator: (req) => `login-user:${loginUsername(req)}`,
  message: {
    success: false,
    error: 'Too many login attempts on this account, please try again later',
  },
});

export const authLimiter = [ipUserLoginLimiter, ipLoginLimiter, accountLoginLimiter];

/** Web file explorer routes: their own, larger budget (filesLimiter) — a folder upload is thousands of requests. */
const FILES_PATH_RE = /^\/api\/accounts\/\d+\/files(?:\/|$)/;

// Signed-in users (apiLimiter skips them): per USER, never per address
// (shared proxy addresses), generous enough for the SPA (sockets carry the
// live updates), bounding scripted floods. Mutations have a tighter budget.
export const userApiLimiter = [
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !req.session?.userId || FILES_PATH_RE.test(req.path),
    keyGenerator: (req) => `user:${req.session?.userId}`,
    message: { success: false, error: 'Too many requests, please try again later' },
  }),
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !req.session?.userId || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || FILES_PATH_RE.test(req.path),
    keyGenerator: (req) => `user-write:${req.session?.userId}`,
    message: { success: false, error: 'Too many requests, please try again later' },
  }),
];

/**
 * Web file explorer (files.routes.ts), per user: a folder upload sends one
 * request per small file, three for a chunked one, plus one per folder.
 */
export const filesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30_000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `files:${req.session?.userId ?? reqIpKey(req)}`,
  message: { success: false, error: 'Too many requests, please try again later', code: 'rateLimited' },
});

// Expensive host operations (disk usage walk, staging tree walk, git diff,
// Docker engine checks, container-creating changes): per user, 60 / min.
export const heavyOpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `heavy:${req.session?.userId ?? reqIpKey(req)}`,
  message: { success: false, error: 'Too many requests, please try again in a minute', code: 'rateLimited' },
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
