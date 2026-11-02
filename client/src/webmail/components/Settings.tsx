import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown, ArrowUp, CalendarOff, CornerUpRight, Info, ListFilter, Pencil, Plus, ShieldAlert, Trash2, X,
} from 'lucide-react';
import type { MailRule, MailRuleAction, MailRuleCondition, WebmailForwarding, WebmailRules, WebmailVacation } from '@oblimint/shared';
import { MAIL_RULE_LIMITS } from '@oblimint/shared';
import { cn } from '@/utils/cn';
import {
  cleanRule, emptyRule, enabledRuleTargets, externalTargets, isRuleAddress, mailboxFolderPaths, moveItem, newAction, newCondition,
  PLACEMENT_ACTIONS, RULE_ACTION_KINDS, RULE_CONDITION_KINDS, ruleEnds, ruleProblem, splitList, type RuleActionKind, type RuleConditionKind,
} from '@/utils/mailRules';
import { ApiError, wmApi } from '../api';
import { formatFullDate } from '../lib/format';
import { useWebmail, type SettingsTab } from '../store';
import { Dialog } from './Dialog';
import { useMailboxName } from './MailboxTree';
import { EmptyState, IconButton, PillButton, Spinner } from './ui';

// Mail settings of the webmail (Outlook: Settings → Mail): automatic replies,
// forwarding, rules. Forwarding and rules ARE the panel's settings of the
// mailbox (same rows, checks, sync and audit); what the owner may forward
// outside the account is bounded by the platform (policy.external).

const inputCls = 'w-full rounded-[7px] bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/60 coarse:min-h-10';
const selectCls = cn(inputCls, 'wm-select cursor-pointer pr-8');

type TFn = (k: string, o?: Record<string, unknown>) => string;

/** A refused change, in the user's language: the panel's reason (WebmailError.reason) first, its English message last. */
export function errorText(t: TFn, err: unknown): string {
  if (!(err instanceof ApiError)) return (err as Error)?.message || (t('wm.errors.generic') || 'Something went wrong.');
  const d = err.details ?? {};
  const target = d.target ?? '';
  const max = d.max ?? MAIL_RULE_LIMITS.redirects;
  const n = typeof d.rule === 'number' ? d.rule + 1 : null;
  if (err.code === 'forwardingNotAllowed' || err.reason === 'forwardingNotAllowed') {
    return t('wm.forwarding.notAllowed') || 'Forwarding outside your own domains is not allowed on this platform.';
  }
  if (err.code === 'tooManyAttempts') return t('wm.errors.tooManyAttempts') || 'Too many changes: try again in a minute.';
  switch (err.reason) {
    case 'invalidTarget':
      return target
        ? (t('wm.errors.invalidTarget', { target }) || `${target} is not a mailbox or an alias of your account.`)
        : (t('wm.errors.invalidAddress') || 'One of the addresses is not valid.');
    case 'forwardingLoop': return t('wm.errors.forwardingLoop') || 'This would send the messages round in a loop (an address forwards back here).';
    case 'tooManyRedirects': return t('wm.errors.tooManyRedirects', { max }) || `At most ${max} forwarding destinations in all (forwarding and rules together).`;
    case 'invalidRule':
      return n !== null ? (t('wm.errors.invalidRuleN', { n }) || `Rule ${n} is not valid.`) : (t('wm.errors.invalidRule') || 'A rule is not valid.');
    case 'rulesUnsupported': return t('wm.rules.unsupported') || 'Inbox rules are not available on this mail server.';
    default: break;
  }
  return err.message || (t('wm.errors.generic') || 'Something went wrong.');
}

/** Switch (role switch), Oblidesk pill style. */
export function Switch({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3', disabled && 'cursor-not-allowed opacity-60')}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-bg-active')}>
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
      <span className="min-w-0">
        <span className="block text-[13px] text-text-primary">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] text-text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Comma-separated list kept as typed, parsed on every change. */
function ListInput({ values, onChange, placeholder, lower, invalid, id }: {
  values: string[]; onChange: (v: string[]) => void; placeholder?: string; lower?: boolean; invalid?: boolean; id?: string;
}) {
  const [text, setText] = useState(values.join(', '));
  return (
    <input id={id} value={text} placeholder={placeholder} spellCheck={false}
      onChange={(e) => { setText(e.target.value); onChange(splitList(e.target.value, lower)); }}
      onBlur={() => setText(splitList(text, lower).join(', '))}
      className={cn(inputCls, invalid && 'ring-2 ring-red-500/50')} />
  );
}

function SectionFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-4">{children}</div>;
}

// ── automatic replies ───────────────────────────────────────────────────────

const toLocalInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function VacationSection({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useWebmail((s) => s.toast);
  const [v, setV] = useState<WebmailVacation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    wmApi.vacation().then(setV).catch((err) => setError((err as Error).message));
  }, []);
  const save = async () => {
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await wmApi.saveVacation({
        ...v,
        startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null,
        endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null,
      });
      setV(saved);
      toast('ok', t('wm.vacation.saved') || 'Vacation responder saved');
      onDone();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  if (!v) return <p className="text-sm text-text-muted">{error ?? (t('wm.common.loading') || 'Loading…')}</p>;
  return (
    <div className="space-y-3">
      <Switch checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} label={t('wm.vacation.enabled') || 'Send an automatic reply'} />
      <label className="block space-y-1">
        <span className="text-sm text-text-secondary">{t('wm.compose.subject') || 'Subject'}</span>
        <input value={v.subject} maxLength={200} onChange={(e) => setV({ ...v, subject: e.target.value })} className={inputCls} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm text-text-secondary">{t('wm.vacation.message') || 'Message'}</span>
        <textarea value={v.body} maxLength={10000} rows={6} onChange={(e) => setV({ ...v, body: e.target.value })} className={inputCls} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm text-text-secondary">{t('wm.vacation.from') || 'From (optional)'}</span>
          <input type="datetime-local" value={toLocalInput(v.startsAt)} onChange={(e) => setV({ ...v, startsAt: e.target.value || null })} className={inputCls} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-text-secondary">{t('wm.vacation.until') || 'Until (optional)'}</span>
          <input type="datetime-local" value={toLocalInput(v.endsAt)} onChange={(e) => setV({ ...v, endsAt: e.target.value || null })} className={inputCls} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-text-secondary">{t('wm.vacation.interval') || 'Answer the same sender at most every (days)'}</span>
        <input type="number" min={1} max={30} value={v.intervalDays} onChange={(e) => setV({ ...v, intervalDays: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })} className={cn(inputCls, 'max-w-[8rem]')} />
      </label>
      {error && <p className="wm-warn text-sm">{error}</p>}
      <SectionFooter>
        <PillButton variant="primary" onClick={() => { void save(); }} loading={busy}>{t('wm.common.save') || 'Save'}</PillButton>
      </SectionFooter>
    </div>
  );
}

// ── forwarding ──────────────────────────────────────────────────────────────

function PolicyNote({ policy }: { policy: WebmailForwarding['policy'] }) {
  const { t } = useTranslation();
  if (policy.external) return null;
  return (
    <p className="flex items-start gap-2 rounded-[10px] bg-bg-tertiary px-3 py-2 text-[12px] text-text-secondary">
      <ShieldAlert size={14} className="mt-0.5 shrink-0 text-accent" />
      <span>{t('wm.forwarding.internalOnly', { domains: policy.internalDomains.join(', ') || '—' }) || `On this platform you may only forward to addresses of your own domains (${policy.internalDomains.join(', ')}).`}</span>
    </p>
  );
}

function ForwardingSection() {
  const { t, i18n } = useTranslation();
  const toast = useWebmail((s) => s.toast);
  const setForwarding = useWebmail((s) => s.setForwarding);
  const [f, setF] = useState<WebmailForwarding | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; targets: string[]; keepCopy: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');

  const apply = useCallback((x: WebmailForwarding) => {
    setF(x);
    setDraft({ enabled: x.enabled && x.targets.length > 0, targets: x.targets, keepCopy: x.keepCopy });
    setForwarding(x);
  }, [setForwarding]);
  useEffect(() => {
    wmApi.forwarding().then(apply).catch((err) => setError((err as Error).message));
  }, [apply]);

  if (!f || !draft) return <p className="text-sm text-text-muted">{error ?? (t('wm.common.loading') || 'Loading…')}</p>;
  const refused = (addr: string) => !f.policy.external && !f.targets.includes(addr) && externalTargets([addr], f.policy.internalDomains).length > 0;
  const add = () => {
    const list = splitList(adding, true);
    if (!list.length) return;
    const bad = list.find((a) => !isRuleAddress(a));
    if (bad) { setError(t('wm.forwarding.badAddress', { address: bad }) || `${bad} is not a valid address.`); return; }
    const blocked = list.find(refused);
    if (blocked) { setError(t('wm.forwarding.notAllowed') || 'Forwarding outside your own domains is not allowed on this platform.'); return; }
    const targets = [...new Set([...draft.targets, ...list])].slice(0, 20);
    setDraft({ ...draft, targets, enabled: draft.enabled || draft.targets.length === 0 });
    setAdding('');
    setError(null);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify({ enabled: f.enabled && f.targets.length > 0, targets: f.targets, keepCopy: f.keepCopy });
  const save = async (next = draft) => {
    setBusy(true);
    setError(null);
    try {
      apply(await wmApi.saveForwarding({ ...next, enabled: next.enabled && next.targets.length > 0 }));
      toast('ok', next.enabled && next.targets.length ? (t('wm.forwarding.saved') || 'Forwarding saved') : (t('wm.forwarding.turnedOff') || 'Forwarding turned off'));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-text-muted">{t('wm.forwarding.intro') || 'Forward your e-mail to another address. Inbox rules can also forward only some messages.'}</p>
      {f.changedByPanelAt && (
        <p className="flex items-start gap-2 rounded-[10px] bg-accent/10 px-3 py-2 text-[12px] text-text-secondary">
          <Info size={14} className="mt-0.5 shrink-0 text-accent" />
          <span>{t('wm.forwarding.changedByPanel', { date: formatFullDate(f.changedByPanelAt, i18n.language) }) || `Changed from the Oblimint panel on ${formatFullDate(f.changedByPanelAt, i18n.language)}.`}</span>
        </p>
      )}
      <Switch checked={draft.enabled} disabled={draft.targets.length === 0} onChange={(enabled) => setDraft({ ...draft, enabled })}
        label={t('wm.forwarding.enable') || 'Enable forwarding'}
        hint={draft.targets.length === 0 ? (t('wm.forwarding.addFirst') || 'Add an address first.') : undefined} />
      <div className="space-y-2">
        <label className="text-sm text-text-secondary" htmlFor="wm-fwd-add">{t('wm.forwarding.to') || 'Forward my e-mail to'}</label>
        {draft.targets.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {draft.targets.map((a) => (
              <li key={a} className={cn('inline-flex max-w-full items-center gap-1 rounded-[7px] py-1 pl-2.5 pr-1 font-mono text-[12px]', draft.enabled ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary')}>
                <span className="truncate">{a}</span>
                <IconButton size="xs" label={t('wm.common.remove') || 'Remove'} onClick={() => setDraft({ ...draft, targets: draft.targets.filter((x) => x !== a) })}><X size={12} /></IconButton>
              </li>
            ))}
          </ul>
        )}
        {draft.targets.length < 20 && (
          <div className="flex gap-2">
            <input id="wm-fwd-add" type="email" inputMode="email" value={adding} placeholder="someone@example.com" spellCheck={false}
              onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} className={inputCls} />
            <PillButton icon={<Plus size={14} />} onClick={add} disabled={!adding.trim()}>{t('wm.common.add') || 'Add'}</PillButton>
          </div>
        )}
      </div>
      <Switch checked={draft.keepCopy} disabled={draft.targets.length === 0} onChange={(keepCopy) => setDraft({ ...draft, keepCopy })}
        label={t('wm.forwarding.keepCopy') || 'Keep a copy of forwarded messages'}
        hint={!draft.keepCopy ? (t('wm.forwarding.noCopyHint') || 'Messages are not kept in this mailbox (rules do not run on them).') : undefined} />
      <PolicyNote policy={f.policy} />
      {error && <p className="wm-warn text-sm">{error}</p>}
      <SectionFooter>
        {f.active && !dirty && (
          <PillButton variant="ghost" onClick={() => { void save({ ...draft, enabled: false }); }} disabled={busy}>{t('wm.forwarding.disable') || 'Turn off forwarding'}</PillButton>
        )}
        {dirty && <PillButton variant="ghost" onClick={() => apply(f)} disabled={busy}>{t('wm.common.cancel') || 'Cancel'}</PillButton>}
        <PillButton variant="primary" onClick={() => { void save(); }} loading={busy} disabled={!dirty}>{t('wm.common.save') || 'Save'}</PillButton>
      </SectionFooter>
    </div>
  );
}

// ── rules ───────────────────────────────────────────────────────────────────

function useRuleLabels() {
  const { t } = useTranslation();
  const condition = (k: RuleConditionKind) => ({
    from: t('wm.rules.cond.from') || 'From contains',
    toCc: t('wm.rules.cond.toCc') || 'To or Cc contains',
    subject: t('wm.rules.cond.subject') || 'Subject contains',
    body: t('wm.rules.cond.body') || 'Message body contains',
    hasAttachment: t('wm.rules.cond.hasAttachment') || 'Has an attachment',
    sizeOver: t('wm.rules.cond.sizeOver') || 'Larger than (KB)',
    sizeUnder: t('wm.rules.cond.sizeUnder') || 'Smaller than (KB)',
  }[k]);
  const action = (k: RuleActionKind) => ({
    move: t('wm.rules.act.move') || 'Move to folder',
    markRead: t('wm.rules.act.markRead') || 'Mark as read',
    flag: t('wm.rules.act.flag') || 'Flag it',
    forward: t('wm.rules.act.forward') || 'Forward to',
    redirect: t('wm.rules.act.redirect') || 'Redirect to',
    delete: t('wm.rules.act.delete') || 'Delete (Deleted Items)',
    discard: t('wm.rules.act.discard') || 'Delete permanently',
  }[k]);
  const problem = (code: string) => ({
    name: t('wm.rules.problem.name') || 'Give the rule a name.',
    actions: t('wm.rules.problem.actions') || 'Add at least one action.',
    sameAction: t('wm.rules.problem.sameAction') || 'The same action is there twice.',
    oneDestination: t('wm.rules.problem.oneDestination') || 'One destination only: move, delete or redirect.',
    words: t('wm.rules.problem.words') || 'Each condition needs at least one word.',
    size: t('wm.rules.problem.size') || 'Enter a size in KB.',
    folder: t('wm.rules.problem.folder') || 'Choose a folder.',
    targets: t('wm.rules.problem.targets') || 'Enter valid addresses (5 at most).',
    targetSelf: t('wm.rules.problem.targetSelf') || 'A rule cannot forward to this mailbox itself.',
  }[code] ?? code);
  return { condition, action, problem };
}

function summary(r: MailRule, labels: ReturnType<typeof useRuleLabels>, t: (k: string) => string, folderLabel: (p: string) => string): { when: string; then: string } {
  const cond = r.conditions.map((c) => {
    if ('values' in c) return `${labels.condition(c.kind)} « ${c.values.join(' / ')} »`;
    if ('kb' in c) return `${labels.condition(c.kind)} ${c.kb}`;
    return labels.condition(c.kind);
  });
  const acts = r.actions.map((a) => {
    if (a.kind === 'move') return `${labels.action('move')} « ${folderLabel(a.folder)} »`;
    if (a.kind === 'forward' || a.kind === 'redirect') return `${labels.action(a.kind)} ${a.to.join(', ')}`;
    return labels.action(a.kind);
  });
  return {
    when: cond.length ? cond.join(r.match === 'any' ? ` ${t('wm.rules.or') || 'or'} ` : ` ${t('wm.rules.and') || 'and'} `) : (t('wm.rules.allMessages') || 'Every message'),
    then: acts.join(' · ') + (r.stop || ruleEnds(r) ? ` · ${t('wm.rules.stopShort') || 'stop'}` : ''),
  };
}

function RuleEditor({ initial, folders, own, policy, existingTargets, onCancel, onSave, busy, error }: {
  initial: MailRule; folders: Array<{ path: string; label: string }>; own: string; policy: WebmailRules['policy'];
  existingTargets: string[]; onCancel: () => void; onSave: (r: MailRule) => void; busy: boolean; error: string | null;
}) {
  const { t } = useTranslation();
  const labels = useRuleLabels();
  const [r, setR] = useState<MailRule>(initial);
  const [shown, setShown] = useState(false);
  const problem = ruleProblem(r, own);
  const usedKinds = new Set(r.actions.map((a) => a.kind));
  const hasPlacement = r.actions.some((a) => PLACEMENT_ACTIONS.has(a.kind));
  const ends = ruleEnds(r);
  const setCond = (i: number, c: MailRuleCondition) => setR({ ...r, conditions: r.conditions.map((x, j) => (j === i ? c : x)) });
  const setAct = (i: number, a: MailRuleAction) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? a : x)) });
  const blockedTarget = (r.actions.flatMap((a) => (a.kind === 'forward' || a.kind === 'redirect' ? a.to : [])))
    .find((a) => !policy.external && !existingTargets.includes(a) && externalTargets([a], policy.internalDomains).length > 0);
  const submit = () => {
    setShown(true);
    if (problem || blockedTarget) return;
    onSave(cleanRule(r));
  };
  const folderMissing = (p: string) => !!p && !folders.some((f) => f.path === p);

  return (
    <div className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm text-text-secondary">{t('wm.rules.name') || 'Rule name'}</span>
        <input value={r.name} maxLength={MAIL_RULE_LIMITS.nameLength} autoFocus onChange={(e) => setR({ ...r, name: e.target.value })} className={inputCls} />
      </label>

      <div className="space-y-2 rounded-[10px] bg-bg-tertiary/50 p-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-text-primary">
          <span>{t('wm.rules.when') || 'When a message arrives and'}</span>
          <select value={r.match} onChange={(e) => setR({ ...r, match: e.target.value as 'all' | 'any' })} className={cn(selectCls, 'w-auto py-1')} aria-label={t('wm.rules.match') || 'Match'}>
            <option value="all">{t('wm.rules.matchAll') || 'all the conditions match'}</option>
            <option value="any">{t('wm.rules.matchAny') || 'one of the conditions matches'}</option>
          </select>
        </div>
        {r.conditions.length === 0 && <p className="text-[12px] text-text-muted">{t('wm.rules.noCondition') || 'No condition: the rule applies to every message.'}</p>}
        {r.conditions.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-44 shrink-0 text-[12.5px] text-text-secondary max-sm:w-28">{labels.condition(c.kind)}</span>
            <div className="min-w-0 flex-1">
              {'values' in c && <ListInput values={c.values} onChange={(values) => setCond(i, { ...c, values })} placeholder={t('wm.rules.wordsHint') || 'words, separated by commas'} invalid={shown && c.values.length === 0} />}
              {'kb' in c && <input type="number" min={1} max={1048576} value={c.kb} onChange={(e) => setCond(i, { ...c, kb: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} className={cn(inputCls, 'max-w-[10rem]')} />}
            </div>
            <IconButton size="sm" tone="danger" label={t('wm.common.remove') || 'Remove'} onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}><X size={14} /></IconButton>
          </div>
        ))}
        {r.conditions.length < MAIL_RULE_LIMITS.conditionsPerRule && (
          <select value="" onChange={(e) => { if (e.target.value) setR({ ...r, conditions: [...r.conditions, newCondition(e.target.value as RuleConditionKind)] }); }}
            className={cn(selectCls, 'w-auto py-1.5 text-[12.5px]')} aria-label={t('wm.rules.addCondition') || 'Add a condition'}>
            <option value="">{`+ ${t('wm.rules.addCondition') || 'Add a condition'}`}</option>
            {RULE_CONDITION_KINDS.filter((k) => k !== 'hasAttachment' || !r.conditions.some((c) => c.kind === 'hasAttachment')).map((k) => <option key={k} value={k}>{labels.condition(k)}</option>)}
          </select>
        )}
      </div>

      <div className="space-y-2 rounded-[10px] bg-bg-tertiary/50 p-3">
        <div className="text-[13px] font-medium text-text-primary">{t('wm.rules.then') || 'Do the following'}</div>
        {r.actions.map((a, i) => (
          <div key={a.kind} className="flex items-center gap-2">
            <span className="w-44 shrink-0 text-[12.5px] text-text-secondary max-sm:w-28">{labels.action(a.kind)}</span>
            <div className="min-w-0 flex-1">
              {a.kind === 'move' && (
                <select value={a.folder} onChange={(e) => setAct(i, { ...a, folder: e.target.value })} className={cn(selectCls, shown && !a.folder && 'ring-2 ring-red-500/50')}>
                  <option value="">{t('wm.rules.chooseFolder') || 'Choose a folder…'}</option>
                  {folderMissing(a.folder) && <option value={a.folder}>{`${a.folder} (${t('wm.rules.folderMissing') || 'not found'})`}</option>}
                  {folders.map((f) => <option key={f.path} value={f.path}>{f.label}</option>)}
                </select>
              )}
              {(a.kind === 'forward' || a.kind === 'redirect') && (
                <ListInput values={a.to} lower onChange={(to) => setAct(i, { ...a, to })} placeholder="someone@example.com"
                  invalid={shown && (a.to.length === 0 || a.to.some((x) => !isRuleAddress(x)))} />
              )}
            </div>
            <IconButton size="sm" tone="danger" label={t('wm.common.remove') || 'Remove'} onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}><X size={14} /></IconButton>
          </div>
        ))}
        {r.actions.length < MAIL_RULE_LIMITS.actionsPerRule && (
          <select value="" onChange={(e) => { if (e.target.value) setR({ ...r, actions: [...r.actions, newAction(e.target.value as RuleActionKind)] }); }}
            className={cn(selectCls, 'w-auto py-1.5 text-[12.5px]')} aria-label={t('wm.rules.addAction') || 'Add an action'}>
            <option value="">{`+ ${t('wm.rules.addAction') || 'Add an action'}`}</option>
            {RULE_ACTION_KINDS.filter((k) => !usedKinds.has(k) && !(hasPlacement && PLACEMENT_ACTIONS.has(k))).map((k) => <option key={k} value={k}>{labels.action(k)}</option>)}
          </select>
        )}
        {r.actions.some((a) => a.kind === 'redirect') && <p className="text-[12px] text-text-muted">{t('wm.rules.redirectHint') || 'Redirect: the message goes on with its original sender and is not kept here. Forward: a copy goes on, the message stays.'}</p>}
      </div>

      <Switch checked={r.stop || ends} disabled={ends} onChange={(stop) => setR({ ...r, stop })} label={t('wm.rules.stop') || 'Stop processing more rules'}
        hint={ends ? (t('wm.rules.stopForced') || 'The message is gone after this rule: the rules below never run on it.') : undefined} />
      <Switch checked={r.enabled} onChange={(enabled) => setR({ ...r, enabled })} label={t('wm.rules.enabled') || 'Rule turned on'} />
      <PolicyNote policy={policy} />
      {shown && (problem || blockedTarget) && <p className="wm-warn text-sm">{problem ? labels.problem(problem) : (t('wm.forwarding.notAllowed') || 'Forwarding outside your own domains is not allowed on this platform.')}</p>}
      {error && <p className="wm-warn text-sm">{error}</p>}
      <SectionFooter>
        <PillButton variant="ghost" onClick={onCancel} disabled={busy}>{t('wm.common.cancel') || 'Cancel'}</PillButton>
        <PillButton variant="primary" onClick={submit} loading={busy}>{t('wm.rules.saveRule') || 'Save the rule'}</PillButton>
      </SectionFooter>
    </div>
  );
}

function RulesSection({ initialDraft }: { initialDraft: MailRule | null }) {
  const { t } = useTranslation();
  const toast = useWebmail((s) => s.toast);
  const mailboxes = useWebmail((s) => s.mailboxes);
  const session = useWebmail((s) => s.session);
  const nameOf = useMailboxName();
  const labels = useRuleLabels();
  // The forwarding's targets are "already there" too (the server's policy check counts them).
  const forwardTargets = useWebmail((s) => s.forwarding?.targets);
  const [data, setData] = useState<WebmailRules | null>(null);
  const [editing, setEditing] = useState<{ rule: MailRule; index: number | null } | null>(initialDraft ? { rule: initialDraft, index: null } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    wmApi.rules().then(setData).catch((err) => setError((err as Error).message));
  }, []);

  const folders = useMemo(() => {
    const byPath = new Map<string, string>();
    // Labels: the localized name of each folder, indented by depth.
    const paths = mailboxFolderPaths(mailboxes);
    const nameByPath = new Map<string, string>();
    const pathOf = (id: string | null, depth = 0): string | null => {
      const m = mailboxes.find((x) => x.id === id);
      if (!m || depth > 20) return null;
      if (m.role === 'inbox' && !m.parentId) return 'INBOX';
      const head = m.parentId ? pathOf(m.parentId, depth + 1) : '';
      return head === null ? null : head ? `${head}/${m.name}` : m.name;
    };
    for (const m of mailboxes) { const p = pathOf(m.id); if (p) nameByPath.set(p, nameOf(m)); }
    for (const f of paths) byPath.set(f.path, `${'  '.repeat(f.path.split('/').length - 1)}${nameByPath.get(f.path) ?? f.path}`);
    return paths.map((f) => ({ path: f.path, label: byPath.get(f.path) ?? f.path }));
  }, [mailboxes, nameOf]);
  const folderLabel = (p: string) => folders.find((f) => f.path === p)?.label.trim() ?? p;

  const persist = async (rules: MailRule[], okText: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setData(await wmApi.saveRules(rules));
      toast('ok', okText);
      // The banner names the rules that forward: read it again.
      void useWebmail.getState().loadForwarding(true);
      return true;
    } catch (err) {
      setError(errorText(t, err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="text-sm text-text-muted">{error ?? (t('wm.common.loading') || 'Loading…')}</p>;
  if (!data.supported) {
    return <EmptyState icon={<ListFilter size={22} />} title={t('wm.rules.unsupported') || 'Inbox rules are not available on this mail server.'} />;
  }
  const own = session?.address ?? '';
  const existingTargets = [...(forwardTargets ?? []), ...data.rules.flatMap((r) => r.actions.flatMap((a) => (a.kind === 'forward' || a.kind === 'redirect' ? a.to : [])))];

  if (editing) {
    return (
      <RuleEditor key={editing.rule.id} initial={editing.rule} folders={folders} own={own} policy={data.policy} existingTargets={existingTargets} busy={busy} error={error}
        onCancel={() => { setEditing(null); setError(null); }}
        onSave={(rule) => {
          const next = editing.index === null ? [...data.rules, rule] : data.rules.map((x, i) => (i === editing.index ? rule : x));
          if (enabledRuleTargets(next) > data.policy.maxRedirects) { setError(t('wm.rules.tooManyRedirects', { max: data.policy.maxRedirects }) || `At most ${data.policy.maxRedirects} forwarding destinations in all.`); return; }
          void persist(next, t('wm.rules.saved') || 'Rule saved').then((ok) => { if (ok) setEditing(null); });
        }} />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-text-muted">{t('wm.rules.intro') || 'Rules sort incoming messages for you, in this order (spam is left out).'}</p>
      {data.rules.length === 0 ? (
        <EmptyState icon={<ListFilter size={22} />} title={t('wm.rules.none') || 'No rule yet.'} description={t('wm.rules.noneHint') || 'For example: move the invoices into a folder, flag the messages of your manager.'} className="py-8" />
      ) : (
        <ul className="space-y-1.5">
          {data.rules.map((r, i) => {
            const s = summary(r, labels, t, folderLabel);
            return (
              <li key={r.id} className={cn('wm-card flex items-start gap-3 rounded-[10px] bg-bg-secondary px-3 py-2.5', !r.enabled && 'opacity-60')}>
                <span className="mt-0.5"><Switch checked={r.enabled} disabled={busy} label={<span className="sr-only">{r.name}</span>}
                  onChange={(enabled) => { void persist(data.rules.map((x, j) => (j === i ? { ...x, enabled } : x)), enabled ? (t('wm.rules.turnedOn') || 'Rule turned on') : (t('wm.rules.turnedOff') || 'Rule turned off')); }} /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-text-primary">{r.name}</div>
                  <div className="text-[12px] leading-5 text-text-muted"><span className="text-text-secondary">{t('wm.rules.ifShort') || 'If'}</span> {s.when}</div>
                  <div className="text-[12px] leading-5 text-text-muted"><span className="text-text-secondary">{t('wm.rules.thenShort') || 'Then'}</span> {s.then}</div>
                </div>
                <div className="flex shrink-0 items-center">
                  <IconButton size="sm" label={t('wm.rules.up') || 'Move up'} disabled={busy || i === 0} onClick={() => { void persist(moveItem(data.rules, i, -1), t('wm.rules.reordered') || 'Order saved'); }}><ArrowUp size={14} /></IconButton>
                  <IconButton size="sm" label={t('wm.rules.down') || 'Move down'} disabled={busy || i === data.rules.length - 1} onClick={() => { void persist(moveItem(data.rules, i, 1), t('wm.rules.reordered') || 'Order saved'); }}><ArrowDown size={14} /></IconButton>
                  <IconButton size="sm" label={t('wm.rules.edit') || 'Edit'} disabled={busy} onClick={() => { setError(null); setEditing({ rule: r, index: i }); }}><Pencil size={14} /></IconButton>
                  <IconButton size="sm" tone="danger" label={t('wm.rules.delete') || 'Delete the rule'} disabled={busy}
                    onClick={() => { if (window.confirm(t('wm.rules.confirmDelete', { name: r.name }) || `Delete the rule « ${r.name} »?`)) void persist(data.rules.filter((_, j) => j !== i), t('wm.rules.deleted') || 'Rule deleted'); }}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="wm-warn text-sm">{error}</p>}
      <SectionFooter>
        {busy && <Spinner className="text-text-muted" />}
        <PillButton variant="primary" icon={<Plus size={14} />} disabled={busy || data.rules.length >= MAIL_RULE_LIMITS.rules}
          onClick={() => { setError(null); setEditing({ rule: emptyRule(t('wm.rules.newName') || 'New rule'), index: null }); }}>
          {t('wm.rules.add') || 'New rule'}
        </PillButton>
      </SectionFooter>
    </div>
  );
}

// ── the dialog ──────────────────────────────────────────────────────────────

const TABS: Array<{ id: SettingsTab; icon: typeof CalendarOff; key: string; fallback: string }> = [
  { id: 'vacation', icon: CalendarOff, key: 'wm.vacation.title', fallback: 'Automatic replies' },
  { id: 'forwarding', icon: CornerUpRight, key: 'wm.forwarding.title', fallback: 'Forwarding' },
  { id: 'rules', icon: ListFilter, key: 'wm.rules.title', fallback: 'Rules' },
];

export function SettingsDialog() {
  const { t } = useTranslation();
  const open = useWebmail((s) => s.overlay === 'settings');
  const tab = useWebmail((s) => s.settingsTab);
  const ruleDraft = useWebmail((s) => s.ruleDraft);
  const close = useCallback(() => useWebmail.getState().setOverlay(null), []);
  const go = (id: SettingsTab) => useWebmail.getState().openSettings(id);
  return (
    <Dialog open={open} onClose={close} size="xl" title={t('wm.settings.title') || 'Mail settings'} closeLabel={t('wm.common.close') || 'Close'}>
      <div className="flex min-h-[26rem] flex-col gap-4 pb-4 sm:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto sm:w-48 sm:flex-col" aria-label={t('wm.settings.title') || 'Mail settings'}>
          {TABS.map(({ id, icon: Icon, key, fallback }) => (
            <button key={id} type="button" onClick={() => go(id)} aria-current={tab === id ? 'page' : undefined}
              className={cn(
                'flex h-9 shrink-0 items-center gap-2.5 rounded-[7px] px-3 text-left text-[13px] transition-colors coarse:h-10',
                tab === id ? 'bg-accent/15 font-semibold text-accent' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}>
              <Icon size={15} className="shrink-0" />
              <span className="truncate">{t(key) || fallback}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <h3 className="mb-3 text-[15px] font-semibold text-text-primary">{t(TABS.find((x) => x.id === tab)!.key) || TABS.find((x) => x.id === tab)!.fallback}</h3>
          {tab === 'vacation' && <VacationSection onDone={close} />}
          {tab === 'forwarding' && <ForwardingSection />}
          {tab === 'rules' && <RulesSection key={ruleDraft?.id ?? 'list'} initialDraft={ruleDraft} />}
        </div>
      </div>
    </Dialog>
  );
}
