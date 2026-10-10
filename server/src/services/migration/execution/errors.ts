import { AppError } from '../../../middleware/errorHandler';
import { MigrationInterruptedError } from '../contracts/execution';
import { SourceCommandError, SourceCommandRefusedError, SourceConnectionError } from '../contracts/source';

// ─────────────────────────────────────────────────────────────────────────────
// Errors of the execution engine (docs/P5-PLAN.md §9.1, invariant MG2). A
// step error is shown to the platform admin in the run: our own failures
// carry a French message (StepError); a service refusal keeps its code; any
// other backend failure is summarised. EVERY text that leaves a step (error,
// event, result) goes through scrubSecrets: an SQL client echoing a
// statement could otherwise show a password hash.
// ─────────────────────────────────────────────────────────────────────────────

/** Expected failure of a step: its message (French) is the step / run error. */
export class StepError extends Error {
  constructor(message: string, public readonly code: string = 'stepFailed', public readonly params: Record<string, string | number | boolean | null> = {}) {
    super(message);
    this.name = 'StepError';
  }
}

const SECRET_PATTERNS: RegExp[] = [
  // mysql_native_password hash
  /\*[0-9A-Fa-f]{40}\b/g,
  // crypt hashes: bcrypt, sha512/256-crypt, md5-crypt (with optional {SCHEME} prefix)
  /(?:\{[A-Z0-9-]+\})?\$(?:2[abxy]|[156]|5|6)\$[^\s'"`]{8,}/g,
  // PEM private keys (whole block, or a dangling header)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // IDENTIFIED BY '<anything>'
  /(IDENTIFIED\s+(?:BY|WITH\s+\S+\s+AS)\s+(?:PASSWORD\s+)?)'(?:[^'\\]|\\.)*'/gi,
  // MYSQL_PWD=… / PGPASSWORD=…
  /((?:MYSQL_PWD|PGPASSWORD)=)\S+/g,
];

/** Removes anything that looks like a secret from a text shown in the run (errors, events). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m: string, keep?: string) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}<masqué>` : '<masqué>'));
  }
  return out;
}

/** French, secret-free message of a step failure. */
export function stepErrorMessage(err: unknown): string {
  let msg: string;
  if (err instanceof StepError) msg = err.message;
  else if (err instanceof AppError) {
    msg = `Le service a refusé l'opération${err.code ? ` (${err.code})` : ''} : ${err.message}`;
  } else if (err instanceof SourceConnectionError) {
    msg = `Connexion à la source impossible (${err.code}) : ${err.message}`;
  } else if (err instanceof SourceCommandRefusedError) {
    msg = `Commande refusée par l'exécuteur (${err.template}) : ${err.reason}`;
  } else if (err instanceof SourceCommandError) {
    msg = `Commande échouée sur la source (${err.template}, code ${err.exitCode ?? '?'})`;
  } else if (err instanceof MigrationInterruptedError) {
    msg = 'Exécution interrompue';
  } else {
    const raw = err instanceof Error ? err.message : String(err);
    msg = `Erreur interne : ${raw}`;
  }
  return scrubSecrets(msg).slice(0, 2000);
}

/** Code of a failure (AppError / StepError code), for the run events. */
export function errorCode(err: unknown): string {
  if (err instanceof StepError) return err.code;
  if (err instanceof AppError && err.code) return err.code;
  if (err instanceof SourceConnectionError) return err.code;
  if (err instanceof SourceCommandRefusedError || err instanceof SourceCommandError) return err.code;
  return 'internalError';
}
