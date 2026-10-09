import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Wand2, Server } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { ClientCapability, HostingAccount, HostingAccountCreate, Plan } from '@oblimint/shared';
import { CLIENT_CAPABILITIES } from '@oblimint/shared';
import { plansApi } from '@/api/plans.api';
import { accountsApi } from '@/api/accounts.api';
import { useTenantStore } from '@/store/tenantStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { cn } from '@/utils/cn';
import {
  CopyButton, apiErrorCode, envelopeViolations, hostingErrorMessage, inputCls, isStepUpHandled, labelCls, sectionTitleCls, selectCls,
  violationMessages,
} from './hostingUi';
import {
  isValidClientUsername, MIN_CLIENT_PASSWORD, accountUsernameIssue, formatMb, generatePassword, type UsernameIssue,
} from './hostingFormat';
import { CapabilityCheckboxes } from './CapabilityCheckboxes';

export function usernameIssueText(t: TFunction, issue: UsernameIssue): string {
  switch (issue) {
    case 'firstChar': return t('accounts.form.usernameFirstChar') || 'Must start with a lower-case letter.';
    case 'chars': return t('accounts.form.usernameChars') || 'Lower-case letters, digits and hyphens only.';
    case 'tooShort': return t('accounts.form.usernameTooShort') || 'At least 3 characters.';
    case 'tooLong': return t('accounts.form.usernameTooLong') || 'At most 32 characters.';
    default: return '';
  }
}

/** Key limits of a plan, one line ("5 GB · 5 sites · 10 domains · 1 core · 512 MB RAM"). */
export function PlanSummary({ plan }: { plan: Plan }) {
  const { t } = useTranslation();
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  const l = plan.limits;
  const unl = '∞';
  const parts = [
    `${t('plans.limits.disk') || 'Disk'} ${l.diskMb == null ? unl : formatMb(l.diskMb, units)}`,
    `${l.maxSites ?? unl} ${t('plans.short.sites') || 'sites'}`,
    `${l.maxDomains ?? unl} ${t('plans.short.domains') || 'domains'}`,
    `${l.cpuCores ?? unl} ${t('units.cores') || 'cores'}`,
    `${l.memoryMb == null ? unl : formatMb(l.memoryMb, units)} ${t('plans.short.ram') || 'RAM'}`,
  ];
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {parts.map((p) => <span key={p} className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">{p}</span>)}
    </div>
  );
}

export function AccountCreateModal({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (a: HostingAccount) => void;
}) {
  const { t } = useTranslation();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [touched, setTouched] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [planId, setPlanId] = useState<number | ''>('');
  const [withOwner, setWithOwner] = useState(false);
  const [ownerUsername, setOwnerUsername] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [caps, setCaps] = useState<ClientCapability[]>([...CLIENT_CAPABILITIES]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setUsername(''); setTouched(false); setDisplayName(''); setPlanId('');
    setWithOwner(false); setOwnerUsername(''); setOwnerPassword(''); setShowPassword(false); setOwnerEmail('');
    setCaps([...CLIENT_CAPABILITIES]); setError(null); setViolations([]);
    plansApi.list()
      .then((list) => {
        // God view: GET /plans lists every tenant's plans; the account is created in the current tenant.
        const active = list.filter((p) => p.isActive && (currentTenantId == null || p.tenantId === currentTenantId));
        setPlans(active);
        setPlansError(null);
        if (active.length === 1) setPlanId(active[0].id);
      })
      .catch((err) => { setPlans([]); setPlansError(hostingErrorMessage(t, err, t('plans.loadFailed') || 'Failed to load the plans')); });
  }, [open, currentTenantId, t]);

  const issue = accountUsernameIssue(username);
  const plan = plans.find((p) => p.id === planId) ?? null;
  const ownerUserValid = isValidClientUsername(ownerUsername);
  const ownerValid = !withOwner || (ownerUserValid && ownerPassword.length >= MIN_CLIENT_PASSWORD);
  const canSubmit = issue === null && planId !== '' && ownerValid && !saving;

  const submit = async () => {
    setTouched(true);
    if (!canSubmit || typeof planId !== 'number') return;
    const data: HostingAccountCreate = {
      username,
      displayName: displayName.trim() || null,
      planId,
      owner: withOwner ? {
        username: ownerUsername.trim(),
        password: ownerPassword,
        email: ownerEmail.trim() || null,
        displayName: displayName.trim() || null,
        capabilities: caps,
      } : null,
    };
    setSaving(true);
    setError(null);
    setViolations([]);
    try {
      onCreated(await accountsApi.create(data));
    } catch (err) {
      if (apiErrorCode(err) === 'envelopeExceeded') {
        setError(t('hostingCommon.errors.envelopeExceeded') || 'The workspace resource envelope would be exceeded.');
        setViolations(violationMessages(t, envelopeViolations(err)));
      } else {
        if (isStepUpHandled(err)) return;
        setError(hostingErrorMessage(t, err, t('accounts.createFailed') || 'Failed to create the account'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('accounts.form.createTitle') || 'New hosting account'}
      icon={<Server className="h-4 w-4 text-accent" />}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="acct-username">{t('accounts.form.username') || 'Username'}</label>
            <input
              id="acct-username"
              value={username}
              autoFocus
              maxLength={32}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
              onChange={(e) => { setUsername(e.target.value.toLowerCase()); setTouched(true); }}
              className={cn(inputCls, 'font-mono', touched && issue && 'ring-2 ring-status-down')}
              placeholder="client-01"
            />
            {touched && issue && issue !== 'empty'
              ? <p className="mt-1 text-xs text-status-down">{usernameIssueText(t, issue)}</p>
              : <p className="mt-1 text-xs text-text-muted">{t('accounts.form.usernameHint') || 'System and SFTP user name, unique and immutable.'}</p>}
          </div>
          <div>
            <label className={labelCls} htmlFor="acct-display">{t('accounts.form.displayName') || 'Display name'}</label>
            <input id="acct-display" value={displayName} maxLength={100} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} placeholder={t('accounts.form.displayNamePlaceholder') || 'Customer name'} />
          </div>
        </div>

        <div>
          <label className={labelCls} htmlFor="acct-plan">{t('accounts.form.plan') || 'Plan'}</label>
          <select id="acct-plan" value={planId} onChange={(e) => setPlanId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
            <option value="">{t('accounts.form.choosePlan') || 'Choose a plan…'}</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {plansError && <p className="mt-1 text-xs text-status-down">{plansError}</p>}
          {!plansError && plans.length === 0 && <p className="mt-1 text-xs text-text-muted">{t('accounts.form.noPlan') || 'No active plan: create one in Plans first.'}</p>}
          {plan && <PlanSummary plan={plan} />}
        </div>

        <div className="rounded-lg bg-bg-primary p-3">
          <ToggleSwitch
            checked={withOwner}
            onChange={setWithOwner}
            label={t('accounts.form.withOwner') || 'Create a customer login'}
            description={t('accounts.form.withOwnerHint') || 'A client user who signs in to the customer space of this account (local account, never SSO).'}
          />
          {withOwner && (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls} htmlFor="owner-username">{t('accounts.form.ownerUsername') || 'Login'}</label>
                  <input
                    id="owner-username" value={ownerUsername} maxLength={64}
                    autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                    onChange={(e) => setOwnerUsername(e.target.value)}
                    className={cn(inputCls, 'font-mono', ownerUsername && !ownerUserValid && 'ring-2 ring-status-down')}
                  />
                  {ownerUsername && !ownerUserValid && <p className="mt-1 text-xs text-status-down">{t('accounts.form.ownerUsernameInvalid') || '3 to 64 letters, digits, dots, dashes or underscores; og_ is reserved.'}</p>}
                </div>
                <div>
                  <label className={labelCls} htmlFor="owner-email">{t('accounts.form.ownerEmail') || 'E-mail (optional)'}</label>
                  <input id="owner-email" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} className={inputCls} autoComplete="off" />
                </div>
              </div>
              <div>
                <label className={labelCls} htmlFor="owner-password">{t('accounts.form.ownerPassword') || 'Password'}</label>
                <div className="flex items-center gap-1">
                  <input
                    id="owner-password"
                    type={showPassword ? 'text' : 'password'}
                    value={ownerPassword}
                    autoComplete="new-password"
                    onChange={(e) => setOwnerPassword(e.target.value)}
                    className={cn(inputCls, 'font-mono')}
                  />
                  <IconButton label={showPassword ? (t('hostingCommon.hide') || 'Hide') : (t('hostingCommon.show') || 'Show')} icon={showPassword ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setShowPassword((v) => !v)} />
                  <IconButton label={t('hostingCommon.generate') || 'Generate'} icon={<Wand2 size={14} />} onClick={() => { setOwnerPassword(generatePassword(20)); setShowPassword(true); }} />
                  {ownerPassword && <CopyButton text={ownerPassword} />}
                </div>
                {ownerPassword && ownerPassword.length < MIN_CLIENT_PASSWORD && (
                  <p className="mt-1 text-xs text-status-down">{t('accounts.form.passwordTooShort', { count: MIN_CLIENT_PASSWORD, defaultValue: 'At least {{count}} characters.' })}</p>
                )}
              </div>
              <div>
                <div className={cn(sectionTitleCls, 'mb-1.5')}>{t('accounts.users.capabilities') || 'Capabilities'}</div>
                <CapabilityCheckboxes value={caps} onChange={setCaps} />
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-status-down/30 bg-status-down/5 p-3 text-xs text-status-down">
            <p className="whitespace-pre-line">{error}</p>
            {violations.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                {violations.map((v) => <li key={v}>{v}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
