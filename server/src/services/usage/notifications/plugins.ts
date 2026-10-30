import nodemailer from 'nodemailer';
import type { NotificationChannelConfig, NotificationEvent } from '@oblimint/shared';
import { DEFAULT_DEADLINE_MS, DeliveryError, requestJson } from './http';
import { resolvePublicHttpsTarget, resolveSmtpHost, type LookupFn, type PinnedTarget } from './ssrf';

// ─────────────────────────────────────────────────────────────────────────────
// Notification plugins, ported from Obliance server/src/notifications/plugins
// (smtp, webhook, discord, telegram) to Oblimint's payload: French message,
// severity, optional panel link. Every HTTP plugin goes through the SSRF guard
// at send time too (pinned address), SMTP through resolveSmtpHost. User
// controlled text is escaped for HTML mail and Discord mentions are disabled.
// ─────────────────────────────────────────────────────────────────────────────

/** A notification ready to send (rendered once, sent to every channel). */
export interface RenderedNotification {
  event: NotificationEvent | 'test';
  eventLabel: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  /** Absolute panel URL (https://<panel><link>) or null. */
  url: string | null;
  tenantId: number;
  accountId: number | null;
  key: string;
  timestamp: string;
}

/** Secrets of a channel, opened from notification_channels.secrets. */
export interface ChannelSecrets {
  password?: string | null;
  headerValue?: string | null;
  webhookUrl?: string | null;
  botToken?: string | null;
}

export interface MailTransport {
  sendMail(mail: Record<string, unknown>): Promise<unknown>;
  /** Closes the transport's connections (nodemailer); called when the deadline expires. */
  close?(): void;
}

export interface PluginDeps {
  lookup?: LookupFn;
  /** URL → pinned public target (SSRF guard). Tests replace it to reach a local server. */
  resolveTarget: (url: string) => Promise<PinnedTarget>;
  smtpTransport: (options: Record<string, unknown>) => MailTransport;
  /** https://api.telegram.org (tests: a local server). */
  telegramApiBase: string;
  /** Idle timeout of a connection. */
  timeoutMs: number;
  /** Hard wall-clock deadline of one delivery attempt (HTTP request or SMTP send). */
  deadlineMs: number;
}

export const defaultPluginDeps: PluginDeps = {
  resolveTarget: (url) => resolvePublicHttpsTarget(url),
  smtpTransport: (options) => nodemailer.createTransport(options as never) as unknown as MailTransport,
  telegramApiBase: 'https://api.telegram.org',
  timeoutMs: 10_000,
  deadlineMs: DEFAULT_DEADLINE_MS,
};

/** Rejects with DeliveryError('timed out') after `ms`, running `onTimeout` (closes the connection). */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* already closed */ }
      reject(new DeliveryError('timed out'));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([p, expired]).finally(() => { if (timer) clearTimeout(timer); });
}

export const EVENT_LABELS_FR: Record<NotificationEvent | 'test', string> = {
  'quota.warning': 'Seuil de quota atteint',
  'quota.exceeded': 'Quota dépassé',
  'quota.action': 'Action de dépassement de quota',
  'certificate.failed': 'Échec de certificat',
  'certificate.issued': 'Certificat délivré',
  'dns.syncFailed': 'Échec de synchronisation DNS',
  'db.instanceFailed': 'Instance de base de données en échec',
  'cron.failed': 'Tâche planifiée en échec',
  'security.banned': 'Adresse IP bannie',
  // P3
  'window.pendingReview': 'Fenêtre de modification à valider',
  'window.autoValidated': 'Fenêtre de modification validée automatiquement',
  'window.failed': 'Fenêtre de modification en échec',
  'scan.threat': 'Menace détectée par l’analyse',
  'quarantine.added': 'Fichier mis en quarantaine',
  'adapter.completed': 'Mise à jour applicative publiée',
  'adapter.failed': 'Mise à jour applicative en échec',
  'supervision.digest': 'Résumé de supervision',
  // P4
  'mail.outboundSuspended': 'Envoi de mails suspendu',
  'mail.serviceFailed': 'Service mail en échec',
  'mail.quotaWarning': 'Boîte mail presque pleine',
  // P4b
  'certificate.expiringSoon': 'Certificat bientôt expiré',
  'uptime.down': 'Service injoignable',
  'uptime.up': 'Service rétabli',
  'app.updateAvailable': 'Mise à jour d’application disponible',
  'app.updated': 'Application mise à jour',
  'app.updateFailed': 'Échec de mise à jour d’application',
  'app.deployFailed': 'Échec de déploiement d’application',
  'edge.unitQuarantined': 'Configuration de proxy refusée',
  'edge.rollback': 'Configuration du proxy restaurée',
  'workflow.failed': 'Workflow en échec',
  'platform.updateAvailable': 'Mise à jour de la plateforme disponible',
  'platform.updated': 'Plateforme mise à jour',
  'platform.updateFailed': 'Échec de la mise à jour de la plateforme',
  // Notification center
  'release.pendingApproval': 'Release en attente d’approbation',
  'release.approved': 'Release approuvée',
  'release.rejected': 'Release rejetée',
  'domain.verified': 'Propriété du domaine vérifiée',
  'domain.reclaimed': 'Domaine repris par son propriétaire',
  test: 'Test',
};

const SEVERITY_FR: Record<RenderedNotification['severity'], string> = { info: 'Information', warning: 'Avertissement', critical: 'Critique' };
const SEVERITY_ICON: Record<RenderedNotification['severity'], string> = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
const SEVERITY_COLOR: Record<RenderedNotification['severity'], number> = { info: 0x3498db, warning: 0xf39c12, critical: 0xe03a3a };

// SECURITY (from Obliance smtp.ts): HTML-escape user-controlled strings (account
// names, domain names, error text) before they land in an HTML mail body.
export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/** http(s) only in an href, else inert. */
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : '#';
}

const dateFr = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('fr-FR', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'medium' }) + ' UTC';
  } catch {
    return iso;
  }
};

/** Plain-text body shared by SMTP and Telegram. */
export function plainText(n: RenderedNotification): string {
  return [
    `${SEVERITY_ICON[n.severity]} ${n.title}`,
    '',
    n.message,
    '',
    `Événement : ${n.eventLabel}`,
    `Gravité : ${SEVERITY_FR[n.severity]}`,
    `Date : ${dateFr(n.timestamp)}`,
    ...(n.url ? [`Ouvrir dans le panel : ${n.url}`] : []),
    '',
    '— Oblimint',
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function htmlBody(n: RenderedNotification): string {
  const lines = n.message.split('\n').map(escapeHtml).join('<br>');
  return [
    `<h2 style="margin:0 0 12px">${escapeHtml(SEVERITY_ICON[n.severity])} ${escapeHtml(n.title)}</h2>`,
    `<p>${lines}</p>`,
    `<p style="color:#666"><strong>Événement :</strong> ${escapeHtml(n.eventLabel)}<br>`,
    `<strong>Gravité :</strong> ${escapeHtml(SEVERITY_FR[n.severity])}<br>`,
    `<strong>Date :</strong> ${escapeHtml(dateFr(n.timestamp))}</p>`,
    n.url ? `<p><a href="${safeHref(n.url)}">Ouvrir dans le panel</a></p>` : '',
    '<p style="color:#999;font-size:12px">— Oblimint</p>',
  ].filter(Boolean).join('\n');
}

function checkStatus(service: string, status: number): void {
  if (status < 200 || status >= 300) throw new DeliveryError(`${service} a répondu HTTP ${status}`);
}

async function sendSmtp(
  cfg: Extract<NotificationChannelConfig, { type: 'smtp' }>,
  secrets: ChannelSecrets,
  n: RenderedNotification,
  deps: PluginDeps,
  policy: { allowPrivate: boolean; allowLoopback: boolean },
): Promise<void> {
  const pinned = await resolveSmtpHost(cfg.host, { ...policy, lookup: deps.lookup });
  const transport = deps.smtpTransport({
    host: pinned.address,
    port: cfg.port,
    secure: cfg.secure,
    // Certificate checked against the configured name, not the pinned address.
    tls: { servername: cfg.host },
    name: 'oblimint',
    ...(cfg.username ? { auth: { user: cfg.username, pass: secrets.password ?? '' } } : {}),
    connectionTimeout: deps.timeoutMs,
    greetingTimeout: deps.timeoutMs,
    socketTimeout: deps.timeoutMs * 2,
  });
  const sending = transport.sendMail({
    from: cfg.from,
    to: cfg.to.join(', '),
    subject: `[Oblimint] ${n.title}`,
    text: plainText(n),
    html: htmlBody(n),
  });
  sending.catch(() => undefined); // a rejection after the deadline is not unhandled
  // The deadline frees the delivery slot; the abandoned SMTP session itself ends on
  // nodemailer's idle timeouts (a one-shot SMTP transport exposes no socket to cut).
  try {
    await withDeadline(sending, deps.deadlineMs, () => transport.close?.());
  } finally {
    try { transport.close?.(); } catch { /* closed */ }
  }
}

async function sendWebhook(cfg: Extract<NotificationChannelConfig, { type: 'webhook' }>, secrets: ChannelSecrets, n: RenderedNotification, deps: PluginDeps): Promise<void> {
  const target = await deps.resolveTarget(cfg.url);
  const headers: Record<string, string> = {};
  if (cfg.headerName && secrets.headerValue) headers[cfg.headerName] = secrets.headerValue;
  const res = await requestJson(target, {
    method: cfg.method,
    headers,
    timeoutMs: deps.timeoutMs,
    deadlineMs: deps.deadlineMs,
    body: {
      source: 'oblimint',
      event: n.event,
      eventLabel: n.eventLabel,
      title: n.title,
      message: n.message,
      severity: n.severity,
      tenantId: n.tenantId,
      accountId: n.accountId,
      url: n.url,
      key: n.key,
      timestamp: n.timestamp,
    },
  });
  checkStatus('Le webhook', res.status);
}

async function sendDiscord(secrets: ChannelSecrets, n: RenderedNotification, deps: PluginDeps): Promise<void> {
  if (!secrets.webhookUrl) throw new DeliveryError('URL du webhook Discord absente');
  const target = await deps.resolveTarget(secrets.webhookUrl);
  const res = await requestJson(target, {
    method: 'POST',
    timeoutMs: deps.timeoutMs,
    deadlineMs: deps.deadlineMs,
    body: {
      username: 'Oblimint',
      // Never ping @everyone / roles / users from tenant-controlled text.
      allowed_mentions: { parse: [] },
      embeds: [{
        title: `${SEVERITY_ICON[n.severity]} ${n.title}`.slice(0, 256),
        description: n.message.slice(0, 4000),
        color: SEVERITY_COLOR[n.severity],
        ...(n.url ? { url: n.url } : {}),
        fields: [{ name: 'Événement', value: n.eventLabel, inline: true }, { name: 'Gravité', value: SEVERITY_FR[n.severity], inline: true }],
        timestamp: n.timestamp,
      }],
    },
  });
  checkStatus('Discord', res.status);
}

async function sendTelegram(cfg: Extract<NotificationChannelConfig, { type: 'telegram' }>, secrets: ChannelSecrets, n: RenderedNotification, deps: PluginDeps): Promise<void> {
  if (!secrets.botToken) throw new DeliveryError('Jeton du bot Telegram absent');
  // Plain text (no parse_mode): nothing to escape, no "unsupported entity" refusal.
  const endpoint = deps.telegramApiBase.replace(/\/+$/, '') + '/bot' + secrets.botToken + '/sendMessage';
  const target = await deps.resolveTarget(endpoint);
  const res = await requestJson(target, {
    method: 'POST',
    timeoutMs: deps.timeoutMs,
    deadlineMs: deps.deadlineMs,
    body: { chat_id: cfg.chatId, text: plainText(n).slice(0, 4000), disable_web_page_preview: true },
  });
  checkStatus('Telegram', res.status);
}

/**
 * Sends one notification to one channel. Throws DeliveryError / SsrfError /
 * nodemailer errors (the caller retries and records last_error).
 */
export async function sendToChannel(
  cfg: NotificationChannelConfig,
  secrets: ChannelSecrets,
  n: RenderedNotification,
  deps: PluginDeps,
  smtpPolicy: { allowPrivate: boolean; allowLoopback: boolean },
): Promise<void> {
  switch (cfg.type) {
    case 'smtp': return sendSmtp(cfg, secrets, n, deps, smtpPolicy);
    case 'webhook': return sendWebhook(cfg, secrets, n, deps);
    case 'discord': return sendDiscord(secrets, n, deps);
    case 'telegram': return sendTelegram(cfg, secrets, n, deps);
    default: throw new DeliveryError('type de canal inconnu');
  }
}
