import {
  MAIL_CLIENT_ID, MAIL_CLIENT_SCOPE, MAIL_PUBLIC_PORTS,
  type MailClientDiscovery, type MailClientServerEndpoint, type MailClientServers, type MailEngine,
} from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// « Se connecter à Mint », O2 — PURE builders of the discovery document
// (GET /.well-known/oblimint/mail-client, routes/mailPublic.routes.ts) and of
// the engine-dependent `servers` object of the AUTHENTICATED answers (device
// API, lot 2 client API).
//
// Owner's decision P6: the public document never names the engine nor carries
// a field whose value depends on the engine alone (managesieve,
// serverFullTextSearch, imapConnectionsPerUserIp, an engine-specific auth
// mechanism list): the same input on postfix-dovecot and on Stalwart gives the
// same document. No panel version either.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The MailForge sign-in (OAuth public client `mailforge`, flow B) exists from
 * lot 2 (L2b) on: until then the document says oauth.enabled = false and
 * lists no endpoint, whatever settings mail.desktopClients says.
 */
export const MAIL_CLIENT_OAUTH_READY = false;

/** Which parts of the chantier this panel serves (lot 1: manual app passwords + device API). */
export const MAIL_CLIENT_CAPABILITIES = {
  /** MailForge device passwords issued through the client API (C6, lot 2). */
  devicePasswords: false,
  /** GET / DELETE /api/v1/mail/device/self (C7 / C8, L1c). */
  deviceApi: true,
  /** Manual app passwords from the mailbox page (O4a, L1b). */
  manualAppPasswords: true,
} as const;

/** Public endpoints of the node mail host: IMAPS first, submission over implicit TLS (465) first (O6). */
export function publicMailEndpoints(host: string): { imap: MailClientServerEndpoint[]; smtp: MailClientServerEndpoint[]; pop3: MailClientServerEndpoint[] } {
  const P = MAIL_PUBLIC_PORTS;
  return {
    imap: [{ host, port: P.imaps, security: 'tls' }, { host, port: P.imap, security: 'starttls' }],
    smtp: [{ host, port: P.submissions, security: 'tls' }, { host, port: P.submission, security: 'starttls' }],
    pop3: [{ host, port: P.pop3s, security: 'tls' }],
  };
}

export interface DiscoveryInput {
  /** Node mail host name (what clients connect to). */
  host: string;
  /** Mail domain (autoconfig.<domain>), null on a panel host. */
  domain: string | null;
  panelHost: string | null;
  clientHost: string | null;
  desktopClients: boolean;
  maxMessageSizeMb: number;
  authBan: { threshold: number; windowMinutes: number; durationMinutes: number; revokedAllowance: boolean };
  /** Webmail of the domain (domain document only). */
  webmailUrl: string | null;
  /** Lot switch (MAIL_CLIENT_OAUTH_READY), injectable for the tests. */
  oauthReady?: boolean;
}

/** The public document. Pure; never depends on the engine (P6). */
export function buildMailClientDiscovery(input: DiscoveryInput): MailClientDiscovery {
  const panelUrl = input.panelHost ? `https://${input.panelHost}` : null;
  const clientSpaceUrl = input.clientHost ? `https://${input.clientHost}` : null;
  const issuers = [panelUrl, clientSpaceUrl].filter((x): x is string => !!x);
  const enabled = (input.oauthReady ?? MAIL_CLIENT_OAUTH_READY) && input.desktopClients && issuers.length > 0;
  const endpoints: MailClientDiscovery['oauth']['endpoints'] = {};
  if (enabled) {
    // Same origin as the issuer: MailForge checks it (STACK §6 flow B step 2).
    for (const iss of issuers) endpoints[iss] = { authorization: `${iss}/oauth/authorize`, token: `${iss}/oauth/mail-client/token` };
  }
  const doc: MailClientDiscovery = {
    version: 1,
    product: 'oblimint',
    ...(input.domain ? { domain: input.domain } : {}),
    issuers,
    panelUrl,
    clientSpaceUrl,
    oauth: { clientId: MAIL_CLIENT_ID, scope: MAIL_CLIENT_SCOPE, enabled, endpoints },
    mail: {
      username: 'address',
      // Common to both engines (Stalwart does not announce AUTH=LOGIN on IMAP): never betrays the engine.
      authMechanisms: ['PLAIN'],
      ...publicMailEndpoints(input.host),
      tlsNames: [input.host],
      capabilities: {
        ...MAIL_CLIENT_CAPABILITIES,
        panelRules: false,
        idle: true,
        jmap: false,
        caldav: false,
        carddav: false,
      },
      limits: { maxMessageBytes: Math.max(1, Math.floor(input.maxMessageSizeMb)) * 1048576 },
      authBan: { ...input.authBan },
    },
  };
  if (input.domain) doc.webmailUrl = input.webmailUrl;
  return doc;
}

/** Engine-dependent details for AUTHENTICATED answers only (P6). null for an engine without mailboxes. */
export function buildMailClientServers(engine: MailEngine, host: string): MailClientServers | null {
  if (engine !== 'postfix-dovecot' && engine !== 'stalwart') return null;
  const dovecot = engine === 'postfix-dovecot';
  return {
    engine,
    ...publicMailEndpoints(host),
    // ManageSieve is published by postfix-dovecot only (MA-SIEVE); device passwords are refused there (O4s).
    managesieve: dovecot ? { host, port: MAIL_PUBLIC_PORTS.managesieve, security: 'starttls' } : null,
    serverFullTextSearch: !dovecot,
    // confDovecot.ts: mail_max_userip_connections = 20.
    imapConnectionsPerUserIp: dovecot ? 20 : null,
    authMechanisms: dovecot ? ['PLAIN', 'LOGIN'] : ['PLAIN'],
  };
}
