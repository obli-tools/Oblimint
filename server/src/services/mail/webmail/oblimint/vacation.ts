import type { MailAutoresponder } from '@oblimint/shared';
import { isPlainObject } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Vacation responder of the Oblimint webmail = the mailbox's autoresponder
// managed by the panel (mailboxes.autoresponder, rendered by the sync into
// the managed sieve script 'oblimint' together with the forwarding). JMAP
// VacationResponse is NOT used: Stalwart implements it as its own active
// sieve script, which would deactivate the panel's script (forwarding
// included) and fight with every sync. Same bounds as the panel route
// (routes/mail.routes.ts autoresponderInput + assertAutoresponderSchedule).
// ─────────────────────────────────────────────────────────────────────────────

export class VacationInputError extends Error {}

const isoOrNull = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 40) throw new VacationInputError(`${what}: invalid date`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new VacationInputError(`${what}: invalid date`);
  return d.toISOString();
};

/** Validated autoresponder from a webmail request body. Throws VacationInputError. */
export function parseVacationInput(body: unknown): MailAutoresponder {
  if (!isPlainObject(body)) throw new VacationInputError('invalid body');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!['enabled', 'subject', 'body', 'startsAt', 'endsAt', 'intervalDays'].includes(k)) throw new VacationInputError(`unknown field ${k}`);
  }
  if (typeof b.enabled !== 'boolean') throw new VacationInputError('enabled: boolean expected');
  const subject = typeof b.subject === 'string' ? b.subject.trim() : '';
  if (subject.length > 200 || (b.enabled && subject.length === 0)) throw new VacationInputError('subject: 1 to 200 characters');
  const text = typeof b.body === 'string' ? b.body : '';
  if (text.length > 10_000) throw new VacationInputError('body: at most 10000 characters');
  const startsAt = isoOrNull(b.startsAt, 'startsAt');
  const endsAt = isoOrNull(b.endsAt, 'endsAt');
  if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new VacationInputError('endsAt must be after startsAt');
  let intervalDays = 7;
  if (b.intervalDays !== undefined && b.intervalDays !== null) {
    if (typeof b.intervalDays !== 'number' || !Number.isInteger(b.intervalDays) || b.intervalDays < 1 || b.intervalDays > 30) {
      throw new VacationInputError('intervalDays: 1 to 30');
    }
    intervalDays = b.intervalDays;
  }
  return { enabled: b.enabled, subject: subject || 'Out of office', body: text, startsAt, endsAt, intervalDays };
}
