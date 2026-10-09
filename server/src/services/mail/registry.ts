import type { Knex } from 'knex';
import type { MailEngine } from '@oblimint/shared';
import { MAIL_ENGINES } from '@oblimint/shared';
import { appConfigService } from '../appConfig.service';
import type { MailDriver } from './driver';

// ─────────────────────────────────────────────────────────────────────────────
// Active mail engine + driver registry (docs/P4-PLAN.md §5) — ARCHITECT FILE
// (frozen). The engine is app_config `mail_engine` (setup wizard; changed by
// PUT /api/system/mail/engine while no mail domain exists — mail-core). Drivers
// are loaded lazily (a broken engine module never breaks the others).
// ─────────────────────────────────────────────────────────────────────────────

let testDriver: MailDriver | null = null;
let testEngine: MailEngine | null = null;

function engineOf(raw: string | null | undefined): MailEngine {
  const v = raw?.trim() ?? '';
  return (MAIL_ENGINES as readonly string[]).includes(v) ? v as MailEngine : 'external';
}

/** activeMailEngine() read through `conn` (callers inside a transaction). */
export async function activeMailEngineIn(conn: Knex | Knex.Transaction): Promise<MailEngine> {
  if (testEngine) return testEngine;
  const row = await conn('app_config').where({ key: 'mail_engine' }).first('value') as { value: string | null } | undefined;
  return engineOf(row?.value);
}

/** The configured engine; absent / unknown value = 'external' (nothing deployed, DNS only). */
export async function activeMailEngine(): Promise<MailEngine> {
  if (testEngine) return testEngine;
  return engineOf(await appConfigService.get('mail_engine'));
}

/**
 * Driver of the active engine read THROUGH a transaction (integration fix):
 * never take a second pool connection while a transaction holds one (pool
 * exhaustion deadlock; PGlite serialises sessions and hangs outright).
 */
export async function activeMailDriverIn(trx: Knex | Knex.Transaction): Promise<MailDriver> {
  if (testDriver) return testDriver;
  const row = await trx('app_config').where({ key: 'mail_engine' }).first('value') as { value: string | null } | undefined;
  return mailDriverFor(engineOf(row?.value));
}

/** Driver of an engine (lazy import, cached by the module system). */
export async function mailDriverFor(engine: MailEngine): Promise<MailDriver> {
  if (testDriver && testDriver.engine === engine) return testDriver;
  switch (engine) {
    case 'postfix-dovecot': return (await import('./engines/postfixDovecot/driver')).postfixDovecotDriver;
    case 'stalwart': return (await import('./engines/stalwart/driver')).stalwartDriver;
    case 'docker-mailserver':
    case 'maddy': return (await import('./engines/unsupported')).unsupportedDriver(engine);
    case 'external':
    default: return (await import('./engines/external')).externalDriver;
  }
}

/** Driver of the active engine. */
export async function activeMailDriver(): Promise<MailDriver> {
  if (testDriver) return testDriver;
  return mailDriverFor(await activeMailEngine());
}

/** Tests: force the active driver (and its engine); null restores the real ones. */
export function setMailDriverForTests(driver: MailDriver | null): void {
  testDriver = driver;
  testEngine = driver ? driver.engine : null;
}
