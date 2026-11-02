import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerUpRight, ListFilter } from 'lucide-react';
import { wmApi } from '../api';
import { formatFullDate } from '../lib/format';
import { useWebmail } from '../store';
import { errorText } from './Settings';
import { PillButton } from './ui';

/** How often the forwarding is read again in the background (a change from the panel shows up). */
const REFRESH_MS = 5 * 60_000;

const shortList = (list: string[], more: (n: number) => string): string =>
  (list.length > 2 ? `${list.slice(0, 2).join(', ')} ${more(list.length - 2)}` : list.join(', '));

/**
 * Outlook's notice while the mailbox's mail is forwarded: a persistent strip
 * under the header — where it goes, whether a copy is kept, who changed it
 * (the panel) — with Edit and Turn off. Inbox rules that forward / redirect
 * are named too (a rule without a condition does what a forwarding does).
 * Read at start, on focus and every few minutes (the panel may change it
 * meanwhile).
 */
export function ForwardingBanner() {
  const { t, i18n } = useTranslation();
  const forwarding = useWebmail((s) => s.forwarding);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = useWebmail.getState();
    void s.loadForwarding();
    const onFocus = () => { void useWebmail.getState().loadForwarding(true); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(onFocus, REFRESH_MS);
    return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer); };
  }, []);

  const rules = forwarding?.ruleForwards ?? [];
  if (!forwarding || (!forwarding.active && rules.length === 0)) return null;
  const more = (n: number) => t('wm.forwarding.andMore', { count: n }) || `+${n}`;
  const shown = shortList(forwarding.targets, more);
  const ruleTargets = shortList([...new Set(rules.flatMap((r) => r.to))], more);
  const ruleText = rules.length === 1
    ? (t('wm.forwarding.ruleOne', { rule: rules[0].rule, targets: ruleTargets }) || `The rule « ${rules[0].rule} » forwards messages to ${ruleTargets}.`)
    : (t('wm.forwarding.ruleMany', { count: rules.length, targets: ruleTargets }) || `${rules.length} rules forward messages to ${ruleTargets}.`);
  const turnOff = async () => {
    const s = useWebmail.getState();
    if (!window.confirm(t('wm.forwarding.confirmOff') || 'Turn off the forwarding of your e-mail?')) return;
    setBusy(true);
    try {
      s.setForwarding(await wmApi.saveForwarding({ enabled: false, targets: forwarding.targets, keepCopy: forwarding.keepCopy }));
      s.toast('ok', t('wm.forwarding.turnedOff') || 'Forwarding turned off');
    } catch (err) {
      s.toast('error', errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="status" className="wm-fade-up flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 bg-accent/10 px-3 py-2 text-[12.5px] text-text-primary md:px-4">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-accent/20 text-accent">
        {forwarding.active ? <CornerUpRight size={14} /> : <ListFilter size={14} />}
      </span>
      <span className="min-w-0 flex-1">
        {forwarding.active ? (
          <>
            <span className="font-semibold">{t('wm.forwarding.bannerTitle', { targets: shown }) || `Your e-mail is being forwarded to ${shown}.`}</span>{' '}
            <span className="text-text-secondary">
              {forwarding.keepCopy ? (t('wm.forwarding.bannerCopy') || 'A copy stays in this mailbox.') : (t('wm.forwarding.bannerNoCopy') || 'No copy stays in this mailbox.')}
              {forwarding.changedByPanelAt && ` ${t('wm.forwarding.bannerPanel', { date: formatFullDate(forwarding.changedByPanelAt, i18n.language) }) || `Set from the Oblimint panel on ${formatFullDate(forwarding.changedByPanelAt, i18n.language)}.`}`}
              {rules.length > 0 && ` ${ruleText}`}
            </span>
          </>
        ) : (
          <span className="font-semibold">{ruleText}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {forwarding.active ? (
          <>
            <PillButton size="sm" variant="accent" onClick={() => useWebmail.getState().openSettings('forwarding')}>{t('wm.forwarding.edit') || 'Edit'}</PillButton>
            <PillButton size="sm" variant="ghost" loading={busy} onClick={() => { void turnOff(); }}>{t('wm.forwarding.disable') || 'Turn off forwarding'}</PillButton>
          </>
        ) : (
          <PillButton size="sm" variant="accent" onClick={() => useWebmail.getState().openSettings('rules')}>{t('wm.forwarding.seeRules') || 'See the rules'}</PillButton>
        )}
      </span>
    </div>
  );
}
