import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import fs from 'fs';
import path from 'path';
import { config, sessionSecretError } from './config';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';
import { sessionUserGuard } from './middleware/sessionUserGuard';
import { captureStepUpProof } from './middleware/captureStepUpProof';
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
  // The panel is published directly (8443): by default req.ip is the socket
  // peer (rate-limit key). TRUST_PROXY_HOPS when a reverse proxy fronts it.
  app.set('trust proxy', config.trustProxyHops > 0 ? config.trustProxyHops : false);
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
    store: sessionStore,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // HTTPS in production (the container serves TLS itself), HTTP allowed in dev.
      secure: config.nodeEnv === 'production' ? true : config.forceHttps,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  });
  app.use(sessionMiddleware);
  app.use(captureStepUpProof);
  app.use(sessionUserGuard);
  app.use(apiLimiter);

  // Obligate SSO browser redirects (NOT under /api), before /api.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const obligateCallback = require('./routes/obligateCallback.routes').default;
  app.use('/auth', obligateCallback);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { routes } = require('./routes');
  app.use('/api', routes);

  healthRoute(app, 'normal');
  if (!config.isDev || process.env.SERVE_CLIENT === 'true') serveClient(app);
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
