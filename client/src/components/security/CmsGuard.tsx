import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Check, ShieldAlert } from 'lucide-react';
import {
  CMS_GUARD_MAX_FAILURES_RANGE, CMS_GUARD_MODES, CMS_GUARD_WINDOW_RANGE, effectiveCmsGuardMode,
  type CmsGuardMode, type Site,
} from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { Pill } from '@/components/common/Pill';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Card } from '@/components/hosting/hostingUi';
import { Field, settingsInputCls } from '@/components/settings/SettingsBlock';
import { intIn } from '@/components/proxy/proxyFormat';
import { siteErrorMessage } from '@/components/sites/siteErrors';
import { fieldCls, labelCls } from '@/components/sites/styles';
import { cn } from '@/utils/cn';

// Anti brute force of the CMS logins read from the edge log (shared/src/cmsGuard.ts):
// the platform fields of the bans settings and the per-site card of the
// Configuration tab. Relaxing a site (off, more failures, a shorter window)
// takes proxy.manage on top of sites.manage (server rule cmsGuardRelaxForbidden).

const CMS_LIST = 'WordPress (wp-login.php, xmlrpc.php), Joomla, Drupal, PrestaShop, phpMyAdmin';

function useModeLabel(): (m: CmsGuardMode) => string {
  const { t } = useTranslation();
  return (m) => {
    switch (m) {
      case 'auto': return t('cmsGuard.mode.auto') || 'Automatic (journal for 48 h, then bans)';
      case 'off': return t('cmsGuard.mode.off') || 'Off';
      case 'log': return t('cmsGuard.mode.log') || 'Journal only (would-ban entries in the audit log)';
      default: return t('cmsGuard.mode.on') || 'On (bans)';
    }
  };
}

/** Platform fields (Settings > Web bans): mode, thresholds, where 'auto' stands. */
export function CmsGuardPlatformFields({ mode, autoAt, maxFailures, windowMinutes, onChange }: {
  mode: CmsGuardMode;
  autoAt: string | null;
  maxFailures: string;
  windowMinutes: string;
  onChange: (p: { cmsGuardMode?: CmsGuardMode; cmsGuardMaxFailures?: string; cmsGuardWindowMinutes?: string }) => void;
}) {
  const { t, i18n } = useTranslation();
  const modeLabel = useModeLabel();
  const effective = effectiveCmsGuardMode({ cmsGuardMode: mode, cmsGuardAutoAt: autoAt });
  const maxOk = intIn(maxFailures, CMS_GUARD_MAX_FAILURES_RANGE.min, CMS_GUARD_MAX_FAILURES_RANGE.max) !== null;
  const winOk = intIn(windowMinutes, CMS_GUARD_WINDOW_RANGE.min, CMS_GUARD_WINDOW_RANGE.max) !== null;
  const range = (min: number, max: number) => t('edgeUnits.settings.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' });
  return (
    <div className="space-y-3 rounded-lg bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert size={14} className="text-accent" />
        <span className="text-sm font-medium text-text-secondary">{t('cmsGuard.platformTitle') || 'CMS login brute force'}</span>
        <Pill tone={effective === 'on' ? 'green' : effective === 'log' ? 'amber' : 'muted'}>
          {effective === 'on' ? (t('cmsGuard.state.on') || 'banning') : effective === 'log' ? (t('cmsGuard.state.log') || 'journal only') : (t('cmsGuard.state.off') || 'off')}
        </Pill>
      </div>
      <p className="text-xs text-text-muted">
        {t('cmsGuard.platformIntro', { list: CMS_LIST, defaultValue: 'Repeated failed logins on the login pages of the sites ({{list}}), read from the edge access log, ban the address on the sites of that account (escalation ladder above). Addresses never banned, the server and the open panel sessions of the administrators, of the staff and of the account users are never banned.' })}
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={t('cmsGuard.modeLabel') || 'Mode'} htmlFor="bans-cms-mode"
          hint={mode === 'auto' && autoAt && effective === 'log'
            ? t('cmsGuard.autoUntil', { at: new Date(autoAt).toLocaleString(i18n.language), defaultValue: 'Bans from {{at}}.' })
            : undefined}>
          <select id="bans-cms-mode" value={mode} onChange={(e) => onChange({ cmsGuardMode: e.target.value as CmsGuardMode })} className={settingsInputCls}>
            {CMS_GUARD_MODES.map((m) => <option key={m} value={m}>{modeLabel(m)}</option>)}
          </select>
        </Field>
        <Field label={t('cmsGuard.maxFailures') || 'Failures before a ban'} htmlFor="bans-cms-max" error={maxOk ? null : range(CMS_GUARD_MAX_FAILURES_RANGE.min, CMS_GUARD_MAX_FAILURES_RANGE.max)}>
          <input id="bans-cms-max" type="number" inputMode="numeric" min={CMS_GUARD_MAX_FAILURES_RANGE.min} max={CMS_GUARD_MAX_FAILURES_RANGE.max} value={maxFailures}
            onChange={(e) => onChange({ cmsGuardMaxFailures: e.target.value })} className={cn(settingsInputCls, 'font-mono', !maxOk && 'ring-2 ring-status-down/50')} />
        </Field>
        <Field label={t('cmsGuard.windowMinutes') || 'Window (minutes)'} htmlFor="bans-cms-window" error={winOk ? null : range(CMS_GUARD_WINDOW_RANGE.min, CMS_GUARD_WINDOW_RANGE.max)}>
          <input id="bans-cms-window" type="number" inputMode="numeric" min={CMS_GUARD_WINDOW_RANGE.min} max={CMS_GUARD_WINDOW_RANGE.max} value={windowMinutes}
            onChange={(e) => onChange({ cmsGuardWindowMinutes: e.target.value })} className={cn(settingsInputCls, 'font-mono', !winOk && 'ring-2 ring-status-down/50')} />
        </Field>
      </div>
      <p className="text-xs text-text-muted">{t('cmsGuard.platformHint') || 'Each site can lower or raise these thresholds, or switch the protection off, in its Configuration tab.'}</p>
    </div>
  );
}

const numText = (n: number | null) => (n === null ? '' : String(n));

/** Per-site card (site > Configuration): switch and thresholds (empty = platform default). */
export function CmsGuardCard({ site, onSiteChange }: { site: Site; onSiteChange: (s: Site) => void }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const canRelax = can('proxy.manage', site.accountId);
  const g = site.cmsGuard ?? { enabled: true, maxFailures: null, windowMinutes: null };

  const initial = useMemo(() => ({ enabled: g.enabled, max: numText(g.maxFailures), win: numText(g.windowMinutes) }), [g.enabled, g.maxFailures, g.windowMinutes]);
  const [draft, setDraft] = useState(initial);
  const [last, setLast] = useState(initial);
  // Follow server-side changes while the form is untouched.
  if (initial !== last) {
    setLast(initial);
    if (draft.enabled === last.enabled && draft.max === last.max && draft.win === last.win) setDraft(initial);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = draft.enabled !== initial.enabled || draft.max !== initial.max || draft.win !== initial.win;

  const maxVal = draft.max.trim() === '' ? null : intIn(draft.max, CMS_GUARD_MAX_FAILURES_RANGE.min, CMS_GUARD_MAX_FAILURES_RANGE.max);
  const winVal = draft.win.trim() === '' ? null : intIn(draft.win, CMS_GUARD_WINDOW_RANGE.min, CMS_GUARD_WINDOW_RANGE.max);
  const maxOk = draft.max.trim() === '' || maxVal !== null;
  const winOk = draft.win.trim() === '' || winVal !== null;

  const save = async () => {
    if (!maxOk || !winOk) return;
    setError('');
    setSaving(true);
    try {
      const updated = await sitesApi.update(site.id, { cmsGuard: { enabled: draft.enabled, maxFailures: maxVal, windowMinutes: winVal } });
      onSiteChange(updated);
      toast.success(t('sites.form.saved') || 'Settings saved');
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canManage || saving;
  return (
    <Card title={t('cmsGuard.siteTitle') || 'CMS login protection'} icon={<ShieldAlert size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">
        {t('cmsGuard.siteIntro', { list: CMS_LIST, defaultValue: 'Repeated failed logins from one address on the login pages of this site ({{list}}) ban that address from the sites of the account, for a duration that grows with each offence. The bans appear in Security > Bans with this site.' })}
      </p>
      <ToggleSwitch
        checked={draft.enabled}
        onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
        disabled={disabled || (!canRelax && initial.enabled && draft.enabled)}
        label={t('cmsGuard.siteEnabled') || 'Protect the logins of this site'}
        description={t('cmsGuard.siteEnabledHint') || 'Switch it off only if a legitimate service logs in many times (an external monitor, a sync tool): its address would be banned.'}
      />
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`cms-max-${site.id}`}>{t('cmsGuard.maxFailures') || 'Failures before a ban'}</label>
          <input id={`cms-max-${site.id}`} type="number" inputMode="numeric" min={CMS_GUARD_MAX_FAILURES_RANGE.min} max={CMS_GUARD_MAX_FAILURES_RANGE.max}
            value={draft.max} placeholder={t('cmsGuard.platformDefault') || 'platform default'} disabled={disabled || !draft.enabled}
            onChange={(e) => setDraft((d) => ({ ...d, max: e.target.value }))} className={cn(fieldCls, 'font-mono', !maxOk && 'ring-2 ring-status-down/50')} />
        </div>
        <div>
          <label className={labelCls} htmlFor={`cms-win-${site.id}`}>{t('cmsGuard.windowMinutes') || 'Window (minutes)'}</label>
          <input id={`cms-win-${site.id}`} type="number" inputMode="numeric" min={CMS_GUARD_WINDOW_RANGE.min} max={CMS_GUARD_WINDOW_RANGE.max}
            value={draft.win} placeholder={t('cmsGuard.platformDefault') || 'platform default'} disabled={disabled || !draft.enabled}
            onChange={(e) => setDraft((d) => ({ ...d, win: e.target.value }))} className={cn(fieldCls, 'font-mono', !winOk && 'ring-2 ring-status-down/50')} />
        </div>
      </div>
      <p className="mt-1 text-xs text-text-muted">{t('cmsGuard.thresholdHint') || 'Empty = the platform default. A login that succeeds resets the count of its address.'}</p>
      {canManage && !canRelax && (
        <p className="mt-3 text-xs text-text-muted">
          {t('cmsGuard.relaxNeedsProxy') || 'Switching the protection off or tolerating more failures takes the right to manage the bans of the account.'}
        </p>
      )}
      {canManage && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => { setDraft(initial); setError(''); }} disabled={saving}>
              {t('common.cancel') || 'Cancel'}
            </Button>
          )}
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty || !maxOk || !winOk}>
            <Check size={14} className="mr-1" />
            {t('common.save') || 'Save'}
          </Button>
        </div>
      )}
    </Card>
  );
}
