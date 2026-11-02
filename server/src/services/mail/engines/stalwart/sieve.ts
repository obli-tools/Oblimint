import type { MailRule, MailRuleCondition } from '@oblimint/shared';
import { MAIL_RULE_LIMITS } from '@oblimint/shared';
import type { DesiredMailbox } from '../../driver';
import { invalid, mailAddress } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// PURE renderer of the per-mailbox sieve script managed by the panel
// (forwarding with / without a local copy, autoresponder with dates, inbox
// rules), installed by the sync through Stalwart's JMAP SieveScript API
// (api.ts H10) under the name 'oblimint' and activated. null = the mailbox
// needs no script.
//
// Escaping (RFC 5228 quoted strings): '\' and '"' are escaped, NUL and the
// other control characters except CR / LF / TAB are dropped; the subject is a
// single line. Addresses are validated (validate.ts). The autoresponder body
// is user content: it only ever goes into the script, never into a log (MA4).
//
// Inbox rules (migration 034, Outlook-like) come after the autoresponder and
// the forwarding, in their order, inside a block that leaves spam out (as
// Outlook does not run rules on junk mail). A forwarding WITHOUT a local
// copy stops the script before them (nothing is kept, nothing to sort).
// "Not kept" is an explicit discard after the redirects: Stalwart files a
// message that was neither kept nor discarded into the Inbox (fail-safe of
// its sieve ingest), a bare redirect included.
// A rule that redirects or deletes for good ends the rules (stop): the
// message is gone, a later rule's fileinto would deliver it again.
// Rule names never reach the script (comments carry the rule's position).
// Extensions used by rules: fileinto, imap4flags (\Seen, \Flagged), copy,
// body, mime (attachment test), special-use (Deleted Items found by its
// role) — checked against the pinned Stalwart release by
// webmail/oblimint/e2e.rules.stalwart.ts. A mailbox without rules gets the
// very same script as before them (same fingerprint: no rewrite).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SUBJECT = 200;
const MAX_BODY = 10_000;
/** Rendered script of one mailbox at most (Stalwart's untrusted script size limit is 100 KiB). */
export const MAX_SCRIPT_BYTES = 64 * 1024;

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

/** Sieve folder name: '/'-separated path, segments trimmed and non-empty. */
function folderName(v: string): string {
  const parts = String(v ?? '').split('/').map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p) || parts.join('/').length > MAIL_RULE_LIMITS.folderLength) throw invalid('rule folder');
  return parts.join('/');
}

function stringList(values: readonly string[], what: string): string {
  const list = (Array.isArray(values) ? values : []).map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!list.length || list.length > MAIL_RULE_LIMITS.valuesPerCondition) throw invalid(what);
  if (list.some((v) => v.length > MAIL_RULE_LIMITS.valueLength)) throw invalid(what);
  return `[${list.map((v) => sieveString(v, true)).join(', ')}]`;
}

function ruleTest(c: MailRuleCondition, req: Set<string>): string {
  switch (c.kind) {
    case 'from': return `header :contains "from" ${stringList(c.values, 'rule condition')}`;
    case 'toCc': return `header :contains ["to", "cc"] ${stringList(c.values, 'rule condition')}`;
    case 'subject': return `header :contains "subject" ${stringList(c.values, 'rule condition')}`;
    case 'body':
      req.add('body');
      return `body :text :contains ${stringList(c.values, 'rule condition')}`;
    case 'hasAttachment':
      req.add('mime');
      return 'header :mime :anychild :contains "Content-Disposition" "attachment"';
    case 'sizeOver': case 'sizeUnder': {
      const kb = Number(c.kb);
      if (!Number.isInteger(kb) || kb < 1 || kb > 1_048_576) throw invalid('rule size');
      return `size ${c.kind === 'sizeOver' ? ':over' : ':under'} ${kb}K`;
    }
    default:
      throw invalid('rule condition');
  }
}

/** Lines of one rule. Actions in a fixed order: flags, forward / redirect, destination, stop. */
function ruleLines(r: MailRule, own: string, req: Set<string>): string[] {
  if (!Array.isArray(r.conditions) || r.conditions.length > MAIL_RULE_LIMITS.conditionsPerRule) throw invalid('rule conditions');
  if (!Array.isArray(r.actions) || r.actions.length > MAIL_RULE_LIMITS.actionsPerRule) throw invalid('rule actions');
  const tests = r.conditions.map((c) => ruleTest(c, req));
  const cond = tests.length === 0 ? 'true' : tests.length === 1 ? tests[0] : `${r.match === 'any' ? 'anyof' : 'allof'}(${tests.join(', ')})`;
  const body: string[] = [];
  const has = (k: string) => r.actions.some((a) => a.kind === k);
  if (has('markRead') || has('flag')) {
    req.add('imap4flags');
    const flags = [has('markRead') ? '\\Seen' : null, has('flag') ? '\\Flagged' : null].filter((f): f is string => !!f);
    body.push(`addflag [${flags.map((f) => sieveString(f, true)).join(', ')}];`);
  }
  // The message is gone (redirected, or deleted for good): nothing is left to sort, the rules
  // below must not file it again — a later fileinto would still deliver it (discard only cancels
  // the implicit keep, RFC 5228 §4.2 / e2e.rules.stalwart.ts).
  let gone = false;
  for (const a of r.actions) {
    if (a.kind !== 'forward' && a.kind !== 'redirect') continue;
    if (!Array.isArray(a.to) || a.to.length > MAIL_RULE_LIMITS.targetsPerAction) throw invalid('rule targets');
    const targets = [...new Set(a.to.map((t) => mailAddress(t, 'rule target')))].filter((t) => t !== own);
    if (a.kind === 'forward' && targets.length) req.add('copy');
    for (const t of targets) body.push(`redirect ${a.kind === 'forward' ? ':copy ' : ''}${sieveString(t)};`);
    // Not kept: an explicit discard (Stalwart files a message nothing kept / discarded into the Inbox anyway).
    if (a.kind === 'redirect' && targets.length) { body.push('discard;'); gone = true; }
  }
  for (const a of r.actions) {
    if (a.kind === 'move') {
      req.add('fileinto');
      body.push(`fileinto ${sieveString(folderName(a.folder), true)};`);
    } else if (a.kind === 'delete') {
      req.add('fileinto');
      req.add('special-use');
      body.push(`fileinto :specialuse ${sieveString('\\Trash', true)} "Deleted Items";`);
    } else if (a.kind === 'discard') {
      body.push('discard;');
      gone = true;
    }
  }
  if (!body.length) return [];
  if (r.stop || gone) body.push('stop;');
  return [`if ${cond} {`, ...body.map((l) => `  ${l}`), '}'];
}

export function renderSieveScript(mb: Pick<DesiredMailbox, 'forward' | 'autoresponder' | 'address'> & { rules?: DesiredMailbox['rules'] }): string | null {
  const own = mailAddress(mb.address, 'mailbox address');
  const fwd = mb.forward && mb.forward.targets.length ? mb.forward : null;
  const ar = mb.autoresponder;
  const rules = (mb.rules ?? []).filter((r) => r && r.enabled);
  if (rules.length > MAIL_RULE_LIMITS.rules) throw invalid('rules (too many)');
  if (!fwd && !ar && !rules.length) return null;

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
    // No local copy: an explicit discard — Stalwart's ingest files a message that was neither kept
    // nor discarded into the Inbox (fail-safe), a bare redirect included (e2e.rules.stalwart.ts).
    if (!fwd.keepCopy && targets.length) body.push('discard;');
  }

  if (rules.length) {
    const inner: string[] = [];
    rules.forEach((r, i) => {
      const lines = ruleLines(r, own, req);
      if (lines.length) inner.push(`# rule ${i + 1}`, ...lines);
    });
    if (inner.length) {
      // Nothing kept (forwarding without a copy): nothing to sort.
      if (fwd && !fwd.keepCopy && body.includes('discard;')) body.push('stop;');
      body.push('# Inbox rules, in order (spam left out).', 'if not header :matches "X-Spam-Status" "Yes*" {', ...inner.map((l) => `  ${l}`), '}');
    }
  }

  if (!body.length) return null;
  const order = ['copy', 'date', 'relational', 'vacation', 'body', 'fileinto', 'imap4flags', 'mime', 'special-use'].filter((x) => req.has(x));
  const head = ['# Managed by the Oblimint panel — rewritten at every change.'];
  if (order.length) head.push(`require [${order.map((x) => `"${x}"`).join(', ')}];`);
  const script = `${[...head, '', ...body].join('\r\n')}\r\n`;
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) throw invalid('rules (script too large)');
  return script;
}
