import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Check, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  LEAK_ALLOWLIST_MAX, normalizeLeakAllowlistEntry,
  type LeakPolicy, type LeakReport, type LeakRule, type Site,
} from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { Pill } from '@/components/common/Pill';
import { Card } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { siteErrorMessage } from './siteErrors';
import { fieldCls, labelCls, sectionLabelCls } from './styles';

// Leak guard of the publications (secrets, dumps, backups…): the verdict of a
// release (ReleaseDrawer) and the per-site settings (Configuration tab).
// A finding names a file, a line and a rule — never the secret itself.

/** Label of a rule (translated, the rule id as fallback). */
export function useLeakRuleLabel(): (rule: LeakRule) => string {
  const { t } = useTranslation();
  return (rule) => t(`leakGuard.rules.${rule}`, { defaultValue: rule });
}

/** Leak guard section of a release. */
export function LeakReportPanel({ report }: { report: LeakReport }) {
  const { t } = useTranslation();
  const ruleLabel = useLeakRuleLabel();
  const total = report.critical + report.warn;
  return (
    <section>
      <div className={cn(sectionLabelCls, 'flex flex-wrap items-center gap-2')}>
        {t('leakGuard.title') || 'Leak guard'}
        <Pill tone={report.blocked ? 'red' : total ? 'amber' : 'green'}>
          {report.blocked ? (t('leakGuard.verdict.blocked') || 'blocked')
            : total ? t('leakGuard.verdict.findings', { count: total, defaultValue: '{{count}} finding(s)' })
              : (t('leakGuard.verdict.clean') || 'nothing found')}
        </Pill>
        <span className="normal-case tracking-normal text-text-muted/70">
          {report.policy === 'block' ? (t('leakGuard.policy.block') || 'policy: block') : (t('leakGuard.policy.warn') || 'policy: warn')}
        </span>
      </div>
      {report.blocked && (
        <p className="mb-2 flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          {t('leakGuard.blockedText') || 'This release was not published: remove the files below from the staging (secrets go into the site variables), or allowlist their path in the Configuration tab, then publish again.'}
        </p>
      )}
      {(report.allowlisted > 0 || report.contentSkipped > 0) && (
        <p className="mb-2 text-xs text-text-muted">
          {report.allowlisted > 0 && t('leakGuard.allowlisted', { count: report.allowlisted, defaultValue: '{{count}} finding(s) ignored (allowlist).' })}
          {report.allowlisted > 0 && report.contentSkipped > 0 ? ' ' : null}
          {report.contentSkipped > 0 && t('leakGuard.skipped', { count: report.contentSkipped, defaultValue: '{{count}} file(s) not read (too large or over the budget).' })}
        </p>
      )}
      {report.findings.length > 0 && (
        <ul className="space-y-1">
          {report.findings.map((f, i) => (
            <li key={`${f.path}:${f.rule}:${f.line ?? ''}:${i}`} className="rounded-lg bg-bg-tertiary/60 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={f.severity === 'critical' ? 'red' : 'amber'} className="text-[10px] uppercase">
                  {f.severity === 'critical' ? (t('releases.scan.severity.critical') || 'critical') : (t('releases.scan.severity.warn') || 'warning')}
                </Pill>
                {f.served && <Pill tone="muted" className="text-[10px]">{t('leakGuard.served') || 'served as is'}</Pill>}
                <code className="break-all font-mono text-text-primary">{f.path}{f.line != null ? ':' + f.line : ''}</code>
                <span className="font-mono text-text-muted">{f.rule}</span>
              </div>
              <p className="mt-1 text-text-secondary">
                {ruleLabel(f.rule)}
                {f.keyId != null && (
                  <span className="ml-1 inline-flex items-center gap-1 text-red-400">
                    <KeyRound size={12} />{t('leakGuard.revokeKey', { id: f.keyId, defaultValue: 'Access key #{{id}}: revoke it in Access keys.' })}
                  </span>
                )}
              </p>
            </li>
          ))}
          {total > report.findings.length && (
            <li className="px-3 text-xs text-text-muted">{t('leakGuard.more', { count: total - report.findings.length, defaultValue: '… and {{count}} more' })}</li>
          )}
        </ul>
      )}
    </section>
  );
}

const listText = (list: string[]) => list.join('\n');
const parseList = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** Settings of the guard for a site: policy and allowlisted paths. Relaxing takes releases.approve (server rule too). */
export function LeakGuardCard({ site, onSiteChange }: { site: Site; onSiteChange: (s: Site) => void }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const canRelax = can('releases.approve', site.accountId);
  const [policy, setPolicy] = useState<LeakPolicy>(site.leakPolicy);
  const [text, setText] = useState(listText(site.leakAllowlist));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Follow server-side changes while the form is untouched.
  const initial = useMemo(() => ({ policy: site.leakPolicy, text: listText(site.leakAllowlist) }), [site.leakPolicy, site.leakAllowlist]);
  const [last, setLast] = useState(initial);
  if (initial !== last) {
    setLast(initial);
    if (policy === last.policy && text === last.text) { setPolicy(initial.policy); setText(initial.text); }
  }
  const dirty = policy !== initial.policy || text !== initial.text;

  const save = async () => {
    setError('');
    const entries = parseList(text);
    if (entries.length > LEAK_ALLOWLIST_MAX) { setError(t('leakGuard.tooMany', { max: LEAK_ALLOWLIST_MAX, defaultValue: 'At most {{max}} entries.' })); return; }
    const bad = entries.find((e) => normalizeLeakAllowlistEntry(e) === null);
    if (bad !== undefined) { setError(t('leakGuard.invalidEntry', { entry: bad, defaultValue: 'Invalid entry: {{entry}} (a path or glob relative to the code root, no "..", not "**" alone).' })); return; }
    setSaving(true);
    try {
      const updated = await sitesApi.update(site.id, { leakPolicy: policy, leakAllowlist: entries });
      onSiteChange(updated);
      setPolicy(updated.leakPolicy);
      setText(listText(updated.leakAllowlist));
      toast.success(t('sites.form.saved') || 'Settings saved');
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canManage || saving;
  return (
    <Card
      title={t('leakGuard.title') || 'Leak guard'}
      icon={<ShieldCheck size={14} className="text-accent" />}
    >
      <p className="mb-3 text-xs text-text-muted">
        {t('leakGuard.intro') || 'Every publication is checked for committed secrets (keys of this panel, private keys, cloud credentials, .env values) and files that must never be served (SQL dumps, copies of configuration files, backups, phpinfo pages, Adminer, .svn, logs). Findings show the file and the line, never the secret.'}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`leak-policy-${site.id}`}>{t('leakGuard.policyLabel') || 'When a critical finding is found'}</label>
          <select
            id={`leak-policy-${site.id}`}
            value={policy}
            onChange={(e) => setPolicy(e.target.value as LeakPolicy)}
            className={fieldCls}
            disabled={disabled}
          >
            <option value="block">{t('leakGuard.policyBlock') || 'Block the publication (recommended)'}</option>
            <option value="warn" disabled={!canRelax && site.leakPolicy === 'block'}>{t('leakGuard.policyWarn') || 'Publish and warn'}</option>
          </select>
          <p className="mt-1 text-xs text-text-muted">
            {t('leakGuard.policyHint') || 'Critical: the web server would hand the file out as is. A warning (secret inside PHP code, file outside the document root) never blocks.'}
          </p>
        </div>
        <div>
          <label className={labelCls} htmlFor={`leak-allow-${site.id}`}>{t('leakGuard.allowlistLabel') || 'Allowed paths (one per line)'}</label>
          <textarea
            id={`leak-allow-${site.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            disabled={disabled}
            spellCheck={false}
            placeholder={'install/schema.sql\nwp-content/plugins/demo/\n*.example.pem'}
            className={`${fieldCls} resize-y font-mono text-xs leading-relaxed`}
          />
          <p className="mt-1 text-xs text-text-muted">
            {t('leakGuard.allowlistHint') || 'A name ("dump.sql") matches at any depth, "folder/" everything below it; * stays within a folder, ** crosses folders.'}
          </p>
        </div>
      </div>
      {canManage && !canRelax && (
        <p className="mt-3 text-xs text-text-muted">
          {t('leakGuard.relaxNeedsApprove') || 'Switching to warn or adding an allowed path takes the right to approve releases.'}
        </p>
      )}
      {canManage && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => { setPolicy(initial.policy); setText(initial.text); setError(''); }} disabled={saving}>
              {t('common.cancel') || 'Cancel'}
            </Button>
          )}
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
            <Check size={14} className="mr-1" />
            {t('common.save') || 'Save'}
          </Button>
        </div>
      )}
    </Card>
  );
}
