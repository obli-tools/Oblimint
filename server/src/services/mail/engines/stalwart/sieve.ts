import type { DesiredMailbox } from '../../driver';
import { invalid, mailAddress } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// PURE renderer of the per-mailbox sieve script managed by the panel
// (forwarding with / without a local copy, autoresponder with dates), installed
// by the sync through Stalwart's JMAP SieveScript API (api.ts H10) under the
// name 'oblimint' and activated. null = the mailbox needs no script.
//
// Escaping (RFC 5228 quoted strings): '\' and '"' are escaped, NUL and the
// other control characters except CR / LF / TAB are dropped; the subject is a
// single line. Addresses are validated (validate.ts). The autoresponder body
// is user content: it only ever goes into the script, never into a log (MA4).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SUBJECT = 200;
const MAX_BODY = 10_000;

export function sieveString(v: string, singleLine = false): string {
  let s = String(v ?? '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  if (singleLine) s = s.replace(/[\r\n]+/g, ' ');
  else s = s.replace(/\r?\n/g, '\r\n');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 'YYYY-MM-DDTHH:MM:SS' (UTC) of an ISO timestamp: compared as text with currentdate iso8601 (zone +0000). */
function utcStamp(iso: string, what: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw invalid(what);
  return d.toISOString().slice(0, 19);
}

export function renderSieveScript(mb: Pick<DesiredMailbox, 'forward' | 'autoresponder' | 'address'>): string | null {
  const own = mailAddress(mb.address, 'mailbox address');
  const fwd = mb.forward && mb.forward.targets.length ? mb.forward : null;
  const ar = mb.autoresponder;
  if (!fwd && !ar) return null;

  const req = new Set<string>();
  const body: string[] = [];

  if (ar) {
    const days = Math.min(30, Math.max(1, Math.floor(Number(ar.intervalDays) || 1)));
    const conds: string[] = [];
    if (ar.startsAt) conds.push(`currentdate :zone "+0000" :value "ge" "iso8601" ${sieveString(utcStamp(ar.startsAt, 'autoresponder start'))}`);
    if (ar.endsAt) conds.push(`currentdate :zone "+0000" :value "lt" "iso8601" ${sieveString(utcStamp(ar.endsAt, 'autoresponder end'))}`);
    const subject = String(ar.subject ?? '').slice(0, MAX_SUBJECT);
    const text = String(ar.body ?? '').slice(0, MAX_BODY);
    const action = `vacation :days ${days} :addresses [${sieveString(own)}] :subject ${sieveString(subject, true)} ${sieveString(text)};`;
    req.add('vacation');
    if (conds.length) {
      req.add('date');
      req.add('relational');
      body.push(`if allof(${conds.join(', ')}) {`, `  ${action}`, '}');
    } else {
      body.push(action);
    }
  }

  if (fwd) {
    const targets = [...new Set(fwd.targets.map((t) => mailAddress(t, 'forwarding target')))].filter((t) => t !== own);
    if (targets.length > 20) throw invalid('forwarding (more than 20 targets)');
    if (fwd.keepCopy) req.add('copy');
    for (const t of targets) body.push(`redirect ${fwd.keepCopy ? ':copy ' : ''}${sieveString(t)};`);
  }

  const order = ['copy', 'date', 'relational', 'vacation'].filter((x) => req.has(x));
  const head = ['# Managed by the Oblimint panel — rewritten at every change.'];
  if (order.length) head.push(`require [${order.map((x) => `"${x}"`).join(', ')}];`);
  return `${[...head, '', ...body].join('\r\n')}\r\n`;
}
