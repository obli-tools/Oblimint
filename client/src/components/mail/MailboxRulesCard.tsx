import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowDown, ArrowUp, CornerUpRight, ListFilter, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { MailboxDetail, MailRule, MailRuleAction, MailRuleCondition } from '@oblimint/shared';
import { MAIL_RULE_LIMITS } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { Card, Pill, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import {
  cleanRule, emptyRule, enabledRuleTargets, isRuleAddress, moveItem, newAction, newCondition, PLACEMENT_ACTIONS, RULE_ACTION_KINDS,
  RULE_CONDITION_KINDS, ruleEnds, ruleProblem, type RuleActionKind, type RuleConditionKind,
} from '@/utils/mailRules';
import { mailErrorMessage } from './mailErrors';
import { normalizeAddress } from './mailFormat';

// Inbox rules of /mail/mailboxes/:id (Outlook-like; the same rules the
// mailbox owner edits from the Oblimint webmail). Every change saves the
// whole ordered list (PUT /mail/mailboxes/:id/rules, gate mail.mailbox_rules).
// OWNED BY MODULE `ui-mail`.

/**
 * Forwarding banner of the mailbox page (Outlook's notice): where the mail
 * goes, Edit / Turn off; the enabled inbox rules that forward / redirect are
 * named too (a rule without a condition does what a forwarding does).
 */
export function MailboxForwardingNotice({ box, manage, onChanged, onEdit }: { box: MailboxDetail; manage: boolean; onChanged: (b: MailboxDetail) => void; onEdit: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const f = box.forwarding;
  const fwdOn = !!f && f.enabled && f.targets.length > 0;
  const ruleTargets = box.ruleForwardTargets ?? [];
  if (!fwdOn && ruleTargets.length === 0) return null;
  const off = async () => {
    if (!f) return;
    setBusy(true);
    try {
      onChanged(await mailApi.setForwarding(box.id, { targets: f.targets, keepCopy: f.keepCopy, enabled: false }));
      toast.success(t('mail.forwarding.off') || 'Forwarding turned off');
    } catch (err) {
      toast.error(mailErrorMessage(t, err, t('mail.forwarding.saveFailed') || 'Failed to save the forwarding'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-xs text-text-secondary">
      {fwdOn ? <CornerUpRight size={14} className="shrink-0 text-blue-400" /> : <ListFilter size={14} className="shrink-0 text-blue-400" />}
      <span className="min-w-0 flex-1">
        {fwdOn && f && (
          <>
            <span className="font-semibold text-text-primary">{t('mail.forwarding.notice', { targets: f.targets.join(', '), defaultValue: 'The mail of this mailbox is forwarded to {{targets}}.' })}</span>{' '}
            {f.keepCopy ? (t('mail.forwarding.noticeCopy') || 'A copy stays in the mailbox.') : (t('mail.forwarding.noticeNoCopy') || 'No copy stays in the mailbox.')}
            {ruleTargets.length > 0 && ' '}
          </>
        )}
        {ruleTargets.length > 0 && (
          <span className={fwdOn ? undefined : 'font-semibold text-text-primary'}>
            {t('mail.rules.forwardNotice', { targets: ruleTargets.join(', '), defaultValue: 'Inbox rules forward messages of this mailbox to {{targets}}.' })}
          </span>
        )}
      </span>
      {manage && fwdOn && (
        <span className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>{t('common.edit') || 'Edit'}</Button>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => { void off(); }}>{t('mail.forwarding.turnOff') || 'Turn off'}</Button>
        </span>
      )}
    </div>
  );
}

function useLabels() {
  const { t } = useTranslation();
  const condition = (k: RuleConditionKind) => ({
    from: t('mail.rules.cond.from') || 'From contains',
    toCc: t('mail.rules.cond.toCc') || 'To or Cc contains',
    subject: t('mail.rules.cond.subject') || 'Subject contains',
    body: t('mail.rules.cond.body') || 'Body contains',
    hasAttachment: t('mail.rules.cond.hasAttachment') || 'Has an attachment',
    sizeOver: t('mail.rules.cond.sizeOver') || 'Larger than (KB)',
    sizeUnder: t('mail.rules.cond.sizeUnder') || 'Smaller than (KB)',
  }[k]);
  const action = (k: RuleActionKind) => ({
    move: t('mail.rules.act.move') || 'Move to folder',
    markRead: t('mail.rules.act.markRead') || 'Mark as read',
    flag: t('mail.rules.act.flag') || 'Flag',
    forward: t('mail.rules.act.forward') || 'Forward to',
    redirect: t('mail.rules.act.redirect') || 'Redirect to',
    delete: t('mail.rules.act.delete') || 'Delete (Deleted Items)',
    discard: t('mail.rules.act.discard') || 'Delete permanently',
  }[k]);
  const problem = (code: string) => t(`mail.rules.problem.${code}`, { defaultValue: ({
    name: 'Give the rule a name.', actions: 'Add at least one action.', sameAction: 'The same action is there twice.',
    oneDestination: 'One destination only: move, delete or redirect.', words: 'Each condition needs at least one word.', size: 'Enter a size in KB.',
    folder: 'Choose a folder.', targets: 'Enter valid addresses (5 at most).', targetSelf: 'A rule cannot forward to the mailbox itself.',
  } as Record<string, string>)[code] ?? code });
  return { condition, action, problem };
}

function RuleModal({ open, initial, folders, own, onClose, onSave, saving, error, onEdited }: {
  open: boolean; initial: MailRule; folders: string[]; own: string; onClose: () => void; onSave: (r: MailRule) => void; saving: boolean;
  /** Refusal of the last save (server or budget), shown in the modal (the card is under the backdrop). */
  error: string;
  /** The rule was edited: the parent clears that error. */
  onEdited: () => void;
}) {
  const { t } = useTranslation();
  const labels = useLabels();
  const [r, setR0] = useState(initial);
  const [shown, setShown] = useState(false);
  useEffect(() => { setR0(initial); setShown(false); }, [initial]);
  const setR = (next: MailRule) => { setR0(next); if (error) onEdited(); };
  const ends = ruleEnds(r);
  const problem = ruleProblem(r, own);
  const used = new Set(r.actions.map((a) => a.kind));
  const placed = r.actions.some((a) => PLACEMENT_ACTIONS.has(a.kind));
  const setCond = (i: number, c: MailRuleCondition) => setR({ ...r, conditions: r.conditions.map((x, j) => (j === i ? c : x)) });
  const setAct = (i: number, a: MailRuleAction) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? a : x)) });
  const listId = `mbx-rule-folders-${r.id}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={initial.name ? t('mail.rules.editTitle', { name: initial.name, defaultValue: 'Rule {{name}}' }) : (t('mail.rules.createTitle') || 'New rule')}
      icon={<ListFilter className="h-4 w-4 text-accent" />}
      footer={(
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { setShown(true); if (!problem) onSave(cleanRule(r)); }}>{t('common.save') || 'Save'}</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div>
          <label className={labelCls} htmlFor="rule-name">{t('mail.rules.name') || 'Name'}</label>
          <input id="rule-name" value={r.name} maxLength={MAIL_RULE_LIMITS.nameLength} onChange={(e) => setR({ ...r, name: e.target.value })} className={cn(inputCls, shown && !r.name.trim() && 'ring-2 ring-status-down/50')} />
        </div>
        <div className="space-y-2 rounded-lg bg-bg-primary p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-text-secondary">{t('mail.rules.when') || 'When a message arrives and'}</span>
            <select value={r.match} onChange={(e) => setR({ ...r, match: e.target.value as 'all' | 'any' })} className={cn(selectCls, 'w-auto')} aria-label={t('mail.rules.match') || 'Match'}>
              <option value="all">{t('mail.rules.matchAll') || 'all the conditions match'}</option>
              <option value="any">{t('mail.rules.matchAny') || 'one of the conditions matches'}</option>
            </select>
          </div>
          {r.conditions.length === 0 && <p className="text-[11px] text-text-muted">{t('mail.rules.noCondition') || 'No condition: every message.'}</p>}
          {r.conditions.map((c, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="w-40 shrink-0 pt-2 text-xs text-text-secondary max-sm:w-24">{labels.condition(c.kind)}</span>
              <div className="min-w-0 flex-1">
                {'values' in c && <ChipsInput value={c.values} onChange={(values) => setCond(i, { ...c, values })} max={MAIL_RULE_LIMITS.valuesPerCondition} ariaLabel={labels.condition(c.kind)} placeholder={t('mail.rules.wordsHint') || 'a word, Enter'} />}
                {'kb' in c && <input type="number" min={1} max={1048576} value={c.kb} onChange={(e) => setCond(i, { ...c, kb: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} className={cn(inputCls, 'max-w-[10rem] font-mono')} />}
              </div>
              <IconButton size="sm" label={t('common.remove') || 'Remove'} icon={<X className="h-3.5 w-3.5" />} onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })} />
            </div>
          ))}
          {r.conditions.length < MAIL_RULE_LIMITS.conditionsPerRule && (
            <select value="" onChange={(e) => { if (e.target.value) setR({ ...r, conditions: [...r.conditions, newCondition(e.target.value as RuleConditionKind)] }); }} className={cn(selectCls, 'w-auto text-xs')} aria-label={t('mail.rules.addCondition') || 'Add a condition'}>
              <option value="">{`+ ${t('mail.rules.addCondition') || 'Add a condition'}`}</option>
              {RULE_CONDITION_KINDS.filter((k) => k !== 'hasAttachment' || !r.conditions.some((c) => c.kind === k)).map((k) => <option key={k} value={k}>{labels.condition(k)}</option>)}
            </select>
          )}
        </div>
        <div className="space-y-2 rounded-lg bg-bg-primary p-3">
          <div className="text-xs font-semibold text-text-secondary">{t('mail.rules.then') || 'Do the following'}</div>
          {r.actions.map((a, i) => (
            <div key={a.kind} className="flex items-start gap-2">
              <span className="w-40 shrink-0 pt-2 text-xs text-text-secondary max-sm:w-24">{labels.action(a.kind)}</span>
              <div className="min-w-0 flex-1">
                {a.kind === 'move' && (
                  <>
                    <input list={listId} value={a.folder} onChange={(e) => setAct(i, { ...a, folder: e.target.value })} placeholder="Archive/2026" className={cn(inputCls, 'font-mono', shown && !a.folder.trim() && 'ring-2 ring-status-down/50')} />
                    <datalist id={listId}>{folders.map((f) => <option key={f} value={f} />)}</datalist>
                  </>
                )}
                {(a.kind === 'forward' || a.kind === 'redirect') && (
                  <ChipsInput value={a.to} onChange={(to) => setAct(i, { ...a, to })} validate={isRuleAddress} normalize={normalizeAddress} max={MAIL_RULE_LIMITS.targetsPerAction} inputMode="email" placeholder="someone@example.com" ariaLabel={labels.action(a.kind)} />
                )}
              </div>
              <IconButton size="sm" label={t('common.remove') || 'Remove'} icon={<X className="h-3.5 w-3.5" />} onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })} />
            </div>
          ))}
          {r.actions.length < MAIL_RULE_LIMITS.actionsPerRule && (
            <select value="" onChange={(e) => { if (e.target.value) setR({ ...r, actions: [...r.actions, newAction(e.target.value as RuleActionKind)] }); }} className={cn(selectCls, 'w-auto text-xs')} aria-label={t('mail.rules.addAction') || 'Add an action'}>
              <option value="">{`+ ${t('mail.rules.addAction') || 'Add an action'}`}</option>
              {RULE_ACTION_KINDS.filter((k) => !used.has(k) && !(placed && PLACEMENT_ACTIONS.has(k))).map((k) => <option key={k} value={k}>{labels.action(k)}</option>)}
            </select>
          )}
          <p className="text-[11px] text-text-muted">{t('mail.rules.redirectHint') || 'Forward: a copy goes on, the message stays. Redirect: the message goes on with its original sender and is not kept.'}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ToggleSwitch checked={r.stop || ends} disabled={ends} onChange={(stop) => setR({ ...r, stop })} label={t('mail.rules.stop') || 'Stop processing more rules'}
            description={ends ? (t('mail.rules.stopForced') || 'The message is gone after this rule: the rules below never run on it.') : undefined} />
          <ToggleSwitch checked={r.enabled} onChange={(enabled) => setR({ ...r, enabled })} label={t('mail.rules.enabled') || 'Rule turned on'} />
        </div>
        {shown && problem && <p className="text-xs text-status-down">{labels.problem(problem)}</p>}
        {error && <p role="alert" className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

export function MailboxRulesCard({ box, manage, onChanged }: { box: MailboxDetail; manage: boolean; onChanged: (b: MailboxDetail) => void }) {
  const { t } = useTranslation();
  const labels = useLabels();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ rule: MailRule; index: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  useEffect(() => {
    if (!manage || !box.rulesSupported) return;
    let cancelled = false;
    mailApi.mailboxFolders(box.id).then((f) => { if (!cancelled) setFolders(f); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [box.id, box.rulesSupported, manage]);
  const rules = box.rules;
  const fwdTargets = box.forwarding?.enabled ? box.forwarding.targets.length : 0;

  const persist = async (next: MailRule[], ok: string): Promise<boolean> => {
    if (fwdTargets + enabledRuleTargets(next) > MAIL_RULE_LIMITS.redirects) {
      setError(t('mail.rules.tooManyRedirects', { max: MAIL_RULE_LIMITS.redirects, defaultValue: 'At most {{max}} forwarding destinations in all (forwarding and rules together).' }));
      return false;
    }
    setSaving(true);
    setError('');
    try {
      onChanged(await mailApi.setRules(box.id, next));
      toast.success(ok);
      return true;
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.rules.saveFailed') || 'Failed to save the rules'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const describe = useMemo(() => (r: MailRule) => {
    const when = r.conditions.length
      ? r.conditions.map((c) => ('values' in c ? `${labels.condition(c.kind)} « ${c.values.join(' / ')} »` : 'kb' in c ? `${labels.condition(c.kind)} ${c.kb}` : labels.condition(c.kind)))
        .join(r.match === 'any' ? ` ${t('mail.rules.or') || 'or'} ` : ` ${t('mail.rules.and') || 'and'} `)
      : (t('mail.rules.allMessages') || 'Every message');
    const then = r.actions.map((a) => (a.kind === 'move' ? `${labels.action('move')} « ${a.folder} »` : a.kind === 'forward' || a.kind === 'redirect' ? `${labels.action(a.kind)} ${a.to.join(', ')}` : labels.action(a.kind))).join(' · ');
    return { when, then: r.stop || ruleEnds(r) ? `${then} · ${t('mail.rules.stopShort') || 'stop'}` : then };
  }, [labels, t]);

  return (
    <Card
      title={t('mail.rules.title') || 'Inbox rules'}
      icon={<ListFilter size={14} className="text-accent" />}
      actions={(
        <>
          {box.activeRuleCount > 0 ? <Pill tone="accent">{t('mail.rules.activeCount', { count: box.activeRuleCount, defaultValue: '{{count}} on' })}</Pill> : <Pill>{t('mail.rules.noneShort') || 'none'}</Pill>}
          {manage && box.rulesSupported && (
            <Button size="sm" variant="secondary" disabled={saving || rules.length >= MAIL_RULE_LIMITS.rules} onClick={() => { setError(''); setEditing({ rule: emptyRule(''), index: null }); }}>
              <Plus size={13} className="mr-1.5" />{t('mail.rules.add') || 'New rule'}
            </Button>
          )}
        </>
      )}
    >
      {!box.rulesSupported ? (
        <p className="py-2 text-xs text-text-muted">{t('mail.rules.unsupported') || 'Inbox rules need the Stalwart mail engine.'}</p>
      ) : rules.length === 0 ? (
        <p className="py-2 text-xs text-text-muted">{t('mail.rules.none') || 'No rule. The mailbox owner can also create them from the Oblimint webmail.'}</p>
      ) : (
        <ul className="space-y-1.5">
          {rules.map((r, i) => {
            const d = describe(r);
            return (
              <li key={r.id} className={cn('flex items-start gap-3 rounded-lg bg-bg-primary p-2.5', !r.enabled && 'opacity-60')}>
                <ToggleSwitch size="sm" checked={r.enabled} disabled={!manage || saving}
                  onChange={(enabled) => { void persist(rules.map((x, j) => (j === i ? { ...x, enabled } : x)), enabled ? (t('mail.rules.turnedOn') || 'Rule turned on') : (t('mail.rules.turnedOff') || 'Rule turned off')); }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-primary">{r.name}</div>
                  <div className="text-[11px] text-text-muted"><span className="font-semibold text-text-secondary">{t('mail.rules.ifShort') || 'If'}</span> {d.when}</div>
                  <div className="text-[11px] text-text-muted"><span className="font-semibold text-text-secondary">{t('mail.rules.thenShort') || 'Then'}</span> {d.then}</div>
                </div>
                {manage && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton size="sm" label={t('mail.rules.up') || 'Move up'} disabled={saving || i === 0} icon={<ArrowUp className="h-3.5 w-3.5" />} onClick={() => { void persist(moveItem(rules, i, -1), t('mail.rules.reordered') || 'Order saved'); }} />
                    <IconButton size="sm" label={t('mail.rules.down') || 'Move down'} disabled={saving || i === rules.length - 1} icon={<ArrowDown className="h-3.5 w-3.5" />} onClick={() => { void persist(moveItem(rules, i, 1), t('mail.rules.reordered') || 'Order saved'); }} />
                    <IconButton size="sm" label={t('common.edit') || 'Edit'} disabled={saving} icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setError(''); setEditing({ rule: r, index: i }); }} />
                    <IconButton size="sm" label={t('mail.rules.delete') || 'Delete the rule'} disabled={saving} icon={<Trash2 className="h-3.5 w-3.5" />}
                      onClick={async () => {
                        if (await confirm({ title: t('mail.rules.delete') || 'Delete the rule', message: t('mail.rules.confirmDelete', { name: r.name, defaultValue: 'Delete the rule « {{name}} »?' }), confirmLabel: t('common.delete') || 'Delete', danger: true })) {
                          void persist(rules.filter((_, j) => j !== i), t('mail.rules.deleted') || 'Rule deleted');
                        }
                      }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && !editing && <p className="mt-2 whitespace-pre-line text-xs text-status-down">{error}</p>}
      {editing && (
        <RuleModal open initial={editing.rule} folders={folders} own={box.address} saving={saving} error={error} onEdited={() => setError('')}
          onClose={() => { setEditing(null); setError(''); }}
          onSave={(rule) => {
            const next = editing.index === null ? [...rules, rule] : rules.map((x, j) => (j === editing.index ? rule : x));
            void persist(next, t('mail.rules.saved') || 'Rule saved').then((ok) => { if (ok) setEditing(null); });
          }} />
      )}
    </Card>
  );
}
