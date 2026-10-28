import type { HostingActor } from './access';

// status_message of accounts and sites is written by the reconcile as
// "<French label> : <raw Docker / hostd cause>" (several joined with " · ").
// The raw cause (host paths under /srv/oblimint, daemon messages) is for the
// staff; a CLIENT user only gets the labels.

const SEPARATOR = ' · ';
const CAUSE = ' : ';

export function clientStatusMessage(message: string | null): string | null {
  if (!message) return message;
  const labels = message.split(SEPARATOR).map((part) => {
    const i = part.indexOf(CAUSE);
    return (i > 0 ? part.slice(0, i) : part).trim();
  }).filter(Boolean);
  return labels.length ? [...new Set(labels)].join(SEPARATOR) : null;
}

/** The object as `actor` may see it (status message reduced to its labels for a client). */
export function forActor<T extends { statusMessage: string | null; currentReleaseReason?: string | null }>(actor: HostingActor, value: T): T {
  if (actor.kind !== 'client') return value;
  const out = { ...value, statusMessage: clientStatusMessage(value.statusMessage) };
  // A site: the reason of an automatic revert carries the same raw causes.
  if (typeof value.currentReleaseReason === 'string') out.currentReleaseReason = clientStatusMessage(value.currentReleaseReason);
  return out;
}

// Release errors: a pipeline failure that is not a PipelineError is stored as
// "erreur interne : <raw error>" (host paths, syscalls). A client gets the
// prefix only, in `error` and in the log lines.
const INTERNAL_PREFIX = 'erreur interne';
const INTERNAL_FOR_CLIENT = 'erreur interne (détail visible par les administrateurs)';

function redactInternal(text: string | null): string | null {
  return text !== null && text.startsWith(INTERNAL_PREFIX) ? INTERNAL_FOR_CLIENT : text;
}

export function releaseForActor<T extends { error: string | null; log?: Array<{ message: string }> }>(actor: HostingActor, release: T): T {
  if (actor.kind !== 'client') return release;
  const out = { ...release, error: redactInternal(release.error) };
  if (Array.isArray(release.log)) out.log = release.log.map((l) => ({ ...l, message: redactInternal(l.message) ?? '' }));
  return out;
}
