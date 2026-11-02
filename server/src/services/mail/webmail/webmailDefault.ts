import type { MailEngine, WebmailKind } from '@oblimint/shared';
import { logger } from '../../../utils/logger';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import { activeMailEngine } from '../registry';

// ─────────────────────────────────────────────────────────────────────────────
// The built-in Oblimint webmail is the default (migration 033) but needs the
// Stalwart engine (JMAP). On any other engine it would never be served: the
// setting falls back to Roundcube, at boot and after an engine change.
// ─────────────────────────────────────────────────────────────────────────────

/** The webmail to switch to (pure): null when the current one fits the engine. */
export function webmailFallbackFor(current: WebmailKind, engine: MailEngine): WebmailKind | null {
  return current === 'oblimint' && engine !== 'stalwart' ? 'roundcube' : null;
}

/** Applies the fallback; true when the setting changed. Never throws. */
export async function alignWebmailWithEngine(): Promise<boolean> {
  try {
    const [settings, engine] = await Promise.all([platformSettings.get(), activeMailEngine()]);
    const next = webmailFallbackFor(settings.mail.webmail, engine);
    if (!next) return false;
    await platformSettings.update({ mail: { webmail: next } });
    logger.info({ engine, webmail: next }, 'webmail: the Oblimint webmail needs Stalwart, Roundcube is used instead');
    return true;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'webmail: default not aligned with the mail engine');
    return false;
  }
}
