import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import fs from 'fs';
import path from 'path';
import { config, sessionSecretError, sessionCookieSecure, SESSION_COOKIE_NAME } from './config';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter, userApiLimiter } from './middleware/rateLimiter';
import { sessionUserGuard, twoFactorPolicyGuard } from './middleware/sessionUserGuard';
import { originGuard } from './middleware/originGuard';
import { expressTrustProxy } from './utils/clientIp';
import { captureStepUpProof } from './middleware/captureStepUpProof';
import { accessGrantTouch } from './middleware/accessGrantTouch';
import { serverVersion } from './utils/version';
import { logger } from './utils/logger';

const PgSession = connectPgSimple(session);

// The SAME session middleware is shared with Socket.io (socket.ts): sockets
// are authenticated by the httpOnly session cookie only.
let sessionMiddleware: express.RequestHandler | null = null;
export function getSessionMiddleware(): express.RequestHandler | null {
  return sessionMiddleware;
}

/** helmet / CORS / body parsing — common to both modes. */
function baseApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // req.ip (rate-limit key) is the socket peer unless that peer is a TRUSTED
  // proxy: the edge container (addresses read from Docker,
  // services/proxyTrust.ts) or TRUSTED_PROXIES. Never a bare hop count: port
  // 8443 stays published, and a hop count would let any direct client choose
  // its address with X-Forwarded-For.
  app.set('trust proxy', expressTrustProxy(config.trustProxyHops));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'wss:', 'ws:'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          // No upgrade-insecure-requests: the dev server is plain HTTP.
          upgradeInsecureRequests: null,
        },
      },
      hsts: config.panelTls === 'selfsigned' || config.forceHttps ? { maxAge: 31536000, includeSubDomains: false } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    }),
  );
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  // CSRF: state-changing requests only from the panel's origin, JSON bodies only.
  app.use(originGuard);
  app.use(express.json({ limit: '1mb' }));
  return app;
}

/** Built client (production): static files + SPA fallback (never for API paths). */
function serveClient(app: express.Express): void {
  const indexHtml = path.join(config.clientDist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    logger.warn({ clientDist: config.clientDist }, 'Client build not found: the web UI is not served by this process');
    return;
  }
  app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (/^\/(api|auth|socket\.io|health)(\/|$)/.test(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}

function healthRoute(app: express.Express, mode: 'setup' | 'normal'): void {
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode, version: serverVersion, timestamp: new Date().toISOString() });
  });
}

/** NORMAL mode: the full panel. */
export function createApp(): express.Express {
  const app = baseApp();
  app.use(cookieParser());

  const secretError = sessionSecretError();
  if (secretError) {
    logger.fatal(`${secretError} Refusing to start.`);
    process.exit(1);
  }
  const sessionStore = new PgSession({
    conString: config.databaseUrl,
    tableName: 'session',
    createTableIfMissing: false,
  });
  sessionStore.on('error', (err: Error) => {
    logger.error(err, 'Session store error — sessions may fail until the database connection recovers');
  });
  sessionMiddleware = session({
    // `__Host-` prefix when Secure (config.ts): subdomains cannot toss it.
    name: SESSION_COOKIE_NAME,
    store: sessionStore,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // HTTPS in production (the container serves TLS itself), HTTP allowed in dev.
      secure: sessionCookieSecure,
      path: '/',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  });
  // P4 (docs/P4-PLAN.md §6.4): public mail endpoints served through the edge on
  // autoconfig.<d> / autodiscover.<d> / mta-sts.<d> (Thunderbird / Outlook
  // autoconfiguration, MTA-STS policy). NOT under /api, no session, own rate
  // limiter. Mounted BEFORE serveClient: its GET * SPA fallback would answer
  // these paths with index.html otherwise.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mailPublic = require('./routes/mailPublic.routes').default;
  app.use(mailPublic);
  // Static files and the SPA shell first: no session, never counted by the
  // API limiter (logged-out visitors sharing an address must not lock each
  // other out of the login page).
  if (!config.isDev || process.env.SERVE_CLIENT === 'true') serveClient(app);
  app.use(sessionMiddleware);
  app.use(captureStepUpProof);
  app.use(sessionUserGuard);
  app.use(apiLimiter);
  app.use(userApiLimiter);
  // force_2fa: a session without TOTP only reaches the 2FA setup routes.
  app.use(twoFactorPolicyGuard);
  // P2 (hostd-firewall): sessions that passed 2FA refresh their auto-2fa grants. Never blocks.
  app.use(accessGrantTouch);

  // Obligate SSO browser redirects (NOT under /api), before /api.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const obligateCallback = require('./routes/obligateCallback.routes').default;
  app.use('/auth', obligateCallback);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { routes } = require('./routes');
  app.use('/api', routes);

  healthRoute(app, 'normal');
  app.use(errorHandler);
  return app;
}

/** SETUP mode: no database — /health, /api/setup/* and the static client only. */
export function createSetupApp(setupToken: string): express.Express {
  const app = baseApp();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setupModeRouter } = require('./routes/setup.routes');
  app.use('/api/setup', setupModeRouter(setupToken));
  app.use('/api', (_req: express.Request, res: express.Response) => {
    res.status(503).json({ success: false, error: 'The panel is not configured yet: complete the setup wizard', code: 'setupMode' });
  });
  app.use('/auth', (_req: express.Request, res: express.Response) => { res.redirect('/setup'); });
  healthRoute(app, 'setup');
  serveClient(app);
  app.use(errorHandler);
  return app;
}
