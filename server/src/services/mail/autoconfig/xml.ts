import { MAIL_PUBLIC_PORTS } from '@oblimint/shared';
import type { MtaStsMode } from '@oblimint/shared';
import { MTA_STS_MAX_AGE } from '../dns/records';

// ─────────────────────────────────────────────────────────────────────────────
// PURE builders of the public mail autoconfiguration answers (docs/P4-PLAN.md
// §6.4) — module mail-dns-tls, tested by xml.test.ts. Every interpolated value
// is escaped for its format (MA11); nothing but what the DNS already
// publishes (host name, ports) — and the address the client itself sent.
// ─────────────────────────────────────────────────────────────────────────────

/** XML text / attribute escaping (the five predefined entities; control characters dropped). */
export function xmlEscape(value: string): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A lower-case e-mail address (plain local part, host-name domain), else null. */
const EMAIL_RE = /^[a-z0-9!#$%&*+/=?^_`{|}~.-]{1,64}@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeEmail(input: string | null | undefined): string | null {
  const e = String(input ?? '').trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  const local = e.slice(0, e.lastIndexOf('@'));
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  return e;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

/**
 * Outlook POX request → EMailAddress, else null. Plain text scan (no XML
 * parser: no entity expansion, no DTD), bounded input.
 */
export function autodiscoverRequestEmail(body: string | null): string | null {
  if (typeof body !== 'string' || body.length === 0 || body.length > 16 * 1024) return null;
  const m = /<(?:[A-Za-z0-9_-]+:)?EMailAddress\s*>\s*([^<]{1,320}?)\s*<\/(?:[A-Za-z0-9_-]+:)?EMailAddress\s*>/.exec(body);
  return m ? normalizeEmail(m[1]) : null;
}

export interface MailServerInfo {
  /** Mail domain (emailProvider id). */
  domain: string;
  /** Node mail host name. */
  host: string;
}

/** Thunderbird autoconfig (clientConfig v1.1): IMAPS 993, POP3S 995, SMTP 465 (TLS) and 587 (STARTTLS). */
export function thunderbirdXml(info: MailServerInfo): string {
  const d = xmlEscape(info.domain);
  const h = xmlEscape(info.host);
  const P = MAIL_PUBLIC_PORTS;
  const server = (tag: 'incomingServer' | 'outgoingServer', type: string, port: number, socket: 'SSL' | 'STARTTLS') => [
    `    <${tag} type="${type}">`,
    `      <hostname>${h}</hostname>`,
    `      <port>${port}</port>`,
    `      <socketType>${socket}</socketType>`,
    '      <username>%EMAILADDRESS%</username>',
    '      <authentication>password-cleartext</authentication>',
    `    </${tag}>`,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<clientConfig version="1.1">',
    `  <emailProvider id="${d}">`,
    `    <domain>${d}</domain>`,
    `    <displayName>${d}</displayName>`,
    `    <displayShortName>${d}</displayShortName>`,
    ...server('incomingServer', 'imap', P.imaps, 'SSL'),
    ...server('incomingServer', 'imap', P.imap, 'STARTTLS'),
    ...server('incomingServer', 'pop3', P.pop3s, 'SSL'),
    ...server('outgoingServer', 'smtp', P.submissions, 'SSL'),
    ...server('outgoingServer', 'smtp', P.submission, 'STARTTLS'),
    '  </emailProvider>',
    '</clientConfig>',
    '',
  ].join('\n');
}

/** Outlook autodiscover (POX, response schema outlook 2006a) for one address: IMAP 993 + SMTP 465, SSL, login = the address. */
export function outlookXml(info: MailServerInfo & { email: string }): string {
  const h = xmlEscape(info.host);
  const login = xmlEscape(info.email);
  const P = MAIL_PUBLIC_PORTS;
  const protocol = (type: 'IMAP' | 'SMTP', port: number) => [
    '      <Protocol>',
    `        <Type>${type}</Type>`,
    `        <Server>${h}</Server>`,
    `        <Port>${port}</Port>`,
    '        <DomainRequired>off</DomainRequired>',
    `        <LoginName>${login}</LoginName>`,
    '        <SPA>off</SPA>',
    '        <SSL>on</SSL>',
    '        <AuthRequired>on</AuthRequired>',
    ...(type === 'SMTP' ? ['        <UsePOPAuth>off</UsePOPAuth>', '        <SMTPLast>off</SMTPLast>'] : []),
    '      </Protocol>',
  ];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">',
    '  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">',
    '    <Account>',
    '      <AccountType>email</AccountType>',
    '      <Action>settings</Action>',
    ...protocol('IMAP', P.imaps),
    ...protocol('SMTP', P.submissions),
    '    </Account>',
    '  </Response>',
    '</Autodiscover>',
    '',
  ].join('\n');
}

/** MTA-STS policy (RFC 8461 §3.2), CRLF lines. */
export function mtaStsPolicyText(mode: Exclude<MtaStsMode, 'off'>, host: string): string {
  const h = host.toLowerCase().replace(/[^a-z0-9.-]/g, '');
  return [`version: STSv1`, `mode: ${mode}`, `mx: ${h}`, `max_age: ${MTA_STS_MAX_AGE}`, ''].join('\r\n');
}
