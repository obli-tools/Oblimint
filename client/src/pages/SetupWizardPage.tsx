import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  KeyRound, ListChecks, Settings2, Rocket, RefreshCw, CheckCircle2, AlertTriangle, XCircle,
  Copy, ChevronRight, ChevronDown, Loader2, Circle, MinusCircle, Plus, X, ArrowRight, ArrowLeft, Mail,
} from 'lucide-react';
import type {
  HostCheck, HostCheckStatus, MailEngine, SetupApplyRequest, SetupProgress, SetupStep, SetupStepStatus,
} from '@oblimint/shared';
import { isMailEngineSupported } from '@oblimint/shared';
import { setupApi, getSetupToken, setSetupToken } from '@/api/setup.api';
import { apiErrorMessage } from '@/api/client';
import { Logo } from '@/components/common/Logo';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { copyText } from '@/utils/clipboard';
import { cn } from '@/utils/cn';

type WizardStep = 'token' | 'checks' | 'form' | 'progress' | 'restarting';

const PROGRESS_POLL_MS = 1500;
const RESTART_POLL_MS = 2000;

// ── Status visuals ──────────────────────────────────────────────────────────

const CHECK_STYLES: Record<HostCheckStatus, { icon: ReactNode; row: string; text: string }> = {
  ok:   { icon: <CheckCircle2 size={16} className="text-status-up shrink-0" />, row: 'border-l-status-up', text: 'text-status-up' },
  warn: { icon: <AlertTriangle size={16} className="text-status-pending shrink-0" />, row: 'border-l-status-pending', text: 'text-status-pending' },
  fail: { icon: <XCircle size={16} className="text-status-down shrink-0" />, row: 'border-l-status-down', text: 'text-status-down' },
};

function StepStatusIcon({ status }: { status: SetupStepStatus }) {
  switch (status) {
    case 'done': return <CheckCircle2 size={16} className="text-status-up shrink-0" />;
    case 'running': return <Loader2 size={16} className="text-accent animate-spin shrink-0" />;
    case 'error': return <XCircle size={16} className="text-status-down shrink-0" />;
    case 'skipped': return <MinusCircle size={16} className="text-text-muted shrink-0" />;
    default: return <Circle size={16} className="text-text-muted/50 shrink-0" />;
  }
}

/** Wizard progress header: 4 mono labels (token → checks → form → install). */
function StepHeader({ step }: { step: WizardStep }) {
  const { t } = useTranslation();
  const order: Array<{ id: WizardStep; icon: ReactNode; label: string }> = [
    { id: 'token', icon: <KeyRound size={13} />, label: t('setup.nav.token') || 'Token' },
    { id: 'checks', icon: <ListChecks size={13} />, label: t('setup.nav.checks') || 'Host checks' },
    { id: 'form', icon: <Settings2 size={13} />, label: t('setup.nav.form') || 'Configuration' },
    { id: 'progress', icon: <Rocket size={13} />, label: t('setup.nav.install') || 'Installation' },
  ];
  const current = step === 'restarting' ? 3 : order.findIndex((o) => o.id === step);
  return (
    <ol className="flex items-center gap-1 sm:gap-2 overflow-x-auto pb-1">
      {order.map((o, i) => (
        <li key={o.id} className="flex items-center gap-1 sm:gap-2 shrink-0">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-mono uppercase tracking-[0.12em]',
              i === current ? 'bg-accent/12 text-accent' : i < current ? 'text-text-secondary' : 'text-text-muted',
            )}
            aria-current={i === current ? 'step' : undefined}
          >
            {i < current ? <CheckCircle2 size={13} className="text-status-up" /> : o.icon}
            <span className="max-sm:hidden">{o.label}</span>
          </span>
          {i < order.length - 1 && <ChevronRight size={12} className="text-text-muted/60" />}
        </li>
      ))}
    </ol>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl bg-bg-secondary p-5 sm:p-6 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]', className)}>
      {children}
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="font-display text-xl font-semibold tracking-wide text-text-primary">{title}</h2>
      {subtitle && <p className="mt-1 text-xs font-mono tracking-wider text-text-muted">{subtitle}</p>}
    </div>
  );
}

// ── Step 1: token ───────────────────────────────────────────────────────────

function TokenStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      const ok = await setupApi.auth(value);
      if (!ok) throw new Error('refused');
      setSetupToken(value);
      onDone();
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      setError(status === 429
        ? (t('setup.token.tooMany') || 'Too many attempts. Wait a few minutes, then try again.')
        : (t('setup.token.invalid') || 'Invalid setup token.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle
        title={t('setup.token.title') || 'Setup token'}
        subtitle={t('setup.token.subtitle') || 'Prove that you have access to the server.'}
      />
      <p className="text-sm text-text-secondary mb-3">
        {t('setup.token.help') || 'A one-time setup token was printed in the logs of the Oblimint container when it started. Display it with:'}
      </p>
      <pre className="mb-5 rounded-lg bg-bg-primary px-3 py-2 text-xs font-mono text-text-primary overflow-x-auto">docker logs oblimint 2&gt;&amp;1 | grep -i &quot;setup token&quot;</pre>
      <form onSubmit={submit} className="space-y-4">
        <Input
          label={t('setup.token.label') || 'Setup token'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t('setup.token.placeholder') || 'Paste the token here'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono"
          autoFocus
          required
        />
        {error && (
          <div className="rounded-md bg-status-down-bg border border-status-down/30 p-3">
            <p className="text-sm text-status-down">{error}</p>
          </div>
        )}
        <Button type="submit" className="w-full" loading={busy}>
          {t('setup.token.submit') || 'Continue'}
          <ArrowRight size={14} className="ml-1.5" />
        </Button>
      </form>
    </Card>
  );
}

// ── Step 2: host checks ─────────────────────────────────────────────────────

function CheckRow({ check }: { check: HostCheck }) {
  const { t } = useTranslation();
  const style = CHECK_STYLES[check.status];
  const label = t(check.labelKey, { defaultValue: check.id });
  const fix = check.fixKey ? t(check.fixKey, { defaultValue: '' }) : '';
  const copy = async () => {
    if (!check.fixCommand) return;
    const ok = await copyText(check.fixCommand);
    if (ok) toast.success(t('common.copied') || 'Copied');
    else toast.error(t('common.copyFailed') || 'Copy failed');
  };
  return (
    <li className={cn('rounded-lg bg-bg-primary/60 border-l-4 px-4 py-3', style.row)}>
      <div className="flex items-start gap-3">
        {style.icon}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-text-primary">{label}</span>
            <span className={cn('text-[10px] font-mono uppercase tracking-[0.14em]', style.text)}>
              {t(`setup.checkStatus.${check.status}`) || check.status}
            </span>
          </div>
          {check.detail && (
            <p className="mt-1 text-xs font-mono text-text-secondary break-all">{check.detail}</p>
          )}
          {check.status !== 'ok' && fix && (
            <p className="mt-2 text-xs text-text-secondary">{fix}</p>
          )}
          {check.status !== 'ok' && check.fixCommand && (
            <div className="mt-2 flex items-start gap-2">
              <pre className="min-w-0 flex-1 rounded-md bg-bg-tertiary px-3 py-2 text-[11px] font-mono text-text-primary whitespace-pre-wrap break-all">{check.fixCommand}</pre>
              <button
                type="button"
                onClick={copy}
                title={t('common.copy') || 'Copy'}
                aria-label={t('common.copy') || 'Copy'}
                className="shrink-0 rounded-md p-2 text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors coarse:min-h-10 coarse:min-w-10"
              >
                <Copy size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function ChecksStep({ onNext, onAuthLost }: { onNext: () => void; onAuthLost: () => void }) {
  const { t } = useTranslation();
  const [checks, setChecks] = useState<HostCheck[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const run = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setChecks(await setupApi.checks());
    } catch (err) {
      if ((err as { response?: { status?: number } } | null)?.response?.status === 401) { onAuthLost(); return; }
      setError(apiErrorMessage(err, t('setup.checks.failed') || 'The host checks could not be run.'));
    } finally {
      setLoading(false);
    }
  }, [onAuthLost, t]);

  useEffect(() => { void run(); }, [run]);

  const counts = { ok: 0, warn: 0, fail: 0 } as Record<HostCheckStatus, number>;
  for (const c of checks ?? []) counts[c.status]++;
  const blocked = counts.fail > 0;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle
          title={t('setup.checks.title') || 'Host checks'}
          subtitle={t('setup.checks.subtitle') || 'Oblimint inspects the Docker host it runs on.'}
        />
        <Button size="sm" variant="secondary" onClick={() => { void run(); }} loading={loading}>
          <RefreshCw size={14} className="mr-1.5" />
          {t('setup.checks.rerun') || 'Run again'}
        </Button>
      </div>

      {checks && (
        <div className="mb-4 flex flex-wrap gap-2 text-[11px] font-mono uppercase tracking-[0.12em]">
          <span className="rounded-full bg-status-up/10 px-2.5 py-1 text-status-up">{t('setup.checks.countOk', { count: counts.ok, defaultValue: '{{count}} ok' })}</span>
          <span className="rounded-full bg-status-pending/10 px-2.5 py-1 text-status-pending">{t('setup.checks.countWarn', { count: counts.warn, defaultValue: '{{count}} warnings' })}</span>
          <span className="rounded-full bg-status-down/10 px-2.5 py-1 text-status-down">{t('setup.checks.countFail', { count: counts.fail, defaultValue: '{{count}} failures' })}</span>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md bg-status-down-bg border border-status-down/30 p-3">
          <p className="text-sm text-status-down">{error}</p>
        </div>
      )}

      {loading && !checks ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
          <Loader2 size={16} className="animate-spin" />
          {t('setup.checks.running') || 'Running the checks…'}
        </div>
      ) : (
        <ul className="space-y-2">
          {(checks ?? []).map((c) => <CheckRow key={c.id} check={c} />)}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          {blocked
            ? (t('setup.checks.blocked') || 'Fix the failed checks, then run them again.')
            : counts.warn > 0
              ? (t('setup.checks.warnOnly') || 'Warnings do not block the installation, but read them carefully.')
              : (t('setup.checks.allGood') || 'Everything looks good.')}
        </p>
        <Button onClick={onNext} disabled={!checks || blocked || loading}>
          {t('setup.checks.next') || 'Continue'}
          <ArrowRight size={14} className="ml-1.5" />
        </Button>
      </div>
    </Card>
  );
}

// ── Step 3: configuration form ──────────────────────────────────────────────

interface MailEngineInfo {
  id: MailEngine;
  name: string;
  ram: string;
  prosKey: string; prosFallback: string;
  consKey: string; consFallback: string;
}

const MAIL_ENGINES: MailEngineInfo[] = [
  {
    id: 'postfix-dovecot', name: 'Postfix + Dovecot + Rspamd', ram: '300–500 MB',
    prosKey: 'setup.mail.postfix.pros', prosFallback: 'The 20-year standard, rock solid and documented everywhere; same as CWP (Maildir and password hashes reused as is).',
    consKey: 'setup.mail.postfix.cons', consFallback: '4–5 components to configure and upgrade together; the heaviest with antispam.',
  },
  {
    id: 'stalwart', name: 'Stalwart', ram: '100–250 MB',
    prosKey: 'setup.mail.stalwart.pros', prosFallback: 'Modern all-in-one (SMTP, IMAP, JMAP, POP3, antispam, DKIM), administration API, lightweight single binary.',
    consKey: 'setup.mail.stalwart.cons', consFallback: 'Younger: less production hindsight, smaller community; some advanced features under an enterprise licence.',
  },
  {
    id: 'docker-mailserver', name: 'docker-mailserver', ram: '300–500 MB',
    prosKey: 'setup.mail.dms.pros', prosFallback: 'Postfix/Dovecot/Rspamd already assembled and proven in one widely used container.',
    consKey: 'setup.mail.dms.cons', consFallback: 'Driven through files and CLI (no API); big monolithic container.',
  },
  {
    id: 'maddy', name: 'Maddy', ram: '30–80 MB',
    prosKey: 'setup.mail.maddy.pros', prosFallback: 'Very light single Go binary, simple configuration.',
    consKey: 'setup.mail.maddy.cons', consFallback: 'Small community, basic antispam, few hosting features.',
  },
  {
    id: 'external', name: '', ram: '0',
    prosKey: 'setup.mail.external.pros', prosFallback: 'Customers use Google Workspace, Microsoft 365 or another server: the panel only manages the DNS records (MX, SPF, DKIM, DMARC).',
    consKey: 'setup.mail.external.cons', consFallback: 'No mailboxes in the panel.',
  },
];

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

function SetupForm({ onApplied, onBack, onAuthLost }: { onApplied: () => void; onBack: () => void; onAuthLost: () => void }) {
  const { t } = useTranslation();
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const [panelHostname, setPanelHostname] = useState(HOSTNAME_RE.test(host) ? host : '');
  const [ipv4, setIpv4] = useState(IPV4_RE.test(host) ? host : '');
  const [ipv6, setIpv6] = useState('');
  const [nameservers, setNameservers] = useState<string[]>(['', '']);
  const [previewDomain, setPreviewDomain] = useState('');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [mailEngine, setMailEngine] = useState<MailEngine>('postfix-dovecot');
  const [adminUsername, setAdminUsername] = useState('admin');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPassword2, setAdminPassword2] = useState('');
  const [useObligate, setUseObligate] = useState(false);
  const [obligateUrl, setObligateUrl] = useState('');
  const [obligateKey, setObligateKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    const required = t('common.requiredField') || 'This field is required';
    if (!HOSTNAME_RE.test(panelHostname.trim())) e.panelHostname = t('setup.form.errors.hostname') || 'Enter a fully qualified host name (e.g. panel.example.com).';
    if (ipv4.trim() && !IPV4_RE.test(ipv4.trim())) e.ipv4 = t('setup.form.errors.ipv4') || 'Invalid IPv4 address.';
    if (ipv6.trim() && !(IPV6_RE.test(ipv6.trim()) && ipv6.includes(':'))) e.ipv6 = t('setup.form.errors.ipv6') || 'Invalid IPv6 address.';
    if (!ipv4.trim() && !ipv6.trim()) e.ipv4 = t('setup.form.errors.ipRequired') || 'Enter at least one public IP address.';
    const ns = nameservers.map((n) => n.trim()).filter(Boolean);
    if (ns.length === 0) e.nameservers = t('setup.form.errors.nsRequired') || 'Enter at least one name server.';
    else if (ns.some((n) => !HOSTNAME_RE.test(n))) e.nameservers = t('setup.form.errors.nsInvalid') || 'Each name server must be a fully qualified host name.';
    const preview = previewDomain.trim().toLowerCase().replace(/\.$/, '');
    if (preview) {
      const panel = panelHostname.trim().toLowerCase();
      if (!HOSTNAME_RE.test(preview)) e.previewDomain = t('platformSettings.preview.invalid') || 'Enter a domain name (e.g. example-preview.net).';
      else if (panel && preview === panel) {
        e.previewDomain = t('platformSettings.errors.panelHost') || 'This is the panel host name.';
      }
    }
    if (!EMAIL_RE.test(acmeEmail.trim())) e.acmeEmail = t('setup.form.errors.email') || 'Enter a valid e-mail address.';
    if (!adminUsername.trim()) e.adminUsername = required;
    else if (!USERNAME_RE.test(adminUsername.trim())) e.adminUsername = t('setup.form.errors.username') || 'Letters, digits, dot, dash and underscore only.';
    if (adminEmail.trim() && !EMAIL_RE.test(adminEmail.trim())) e.adminEmail = t('setup.form.errors.email') || 'Enter a valid e-mail address.';
    if (adminPassword.length < 12) e.adminPassword = t('setup.form.errors.passwordLength') || 'At least 12 characters.';
    if (adminPassword !== adminPassword2) e.adminPassword2 = t('setup.form.errors.passwordMismatch') || 'Passwords do not match.';
    if (useObligate) {
      if (!/^https?:\/\/.+/i.test(obligateUrl.trim())) e.obligateUrl = t('setup.form.errors.url') || 'Enter a full URL (https://…).';
      if (!obligateKey.trim()) e.obligateKey = required;
    }
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) {
      toast.error(t('setup.form.fixErrors') || 'Please fix the highlighted fields.');
      return;
    }
    const req: SetupApplyRequest = {
      panelHostname: panelHostname.trim().toLowerCase(),
      publicIpv4: ipv4.trim() || null,
      publicIpv6: ipv6.trim() || null,
      nameservers: nameservers.map((n) => n.trim().toLowerCase()).filter(Boolean),
      acmeEmail: acmeEmail.trim(),
      mailEngine,
      previewDomain: previewDomain.trim().toLowerCase().replace(/\.$/, '') || null,
      admin: { username: adminUsername.trim(), password: adminPassword, email: adminEmail.trim() || null },
      obligate: useObligate ? { url: obligateUrl.trim().replace(/\/+$/, ''), apiKey: obligateKey.trim() } : null,
    };
    setBusy(true);
    setServerError('');
    try {
      await setupApi.apply(req);
      onApplied();
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status === 401) { onAuthLost(); return; }
      if (status === 409) { onApplied(); return; } // already started: follow the progress
      setServerError(apiErrorMessage(err, t('setup.form.applyFailed') || 'The installation could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  const err = (k: string) => errors[k];

  return (
    <Card>
      <SectionTitle
        title={t('setup.form.title') || 'Configuration'}
        subtitle={t('setup.form.subtitle') || 'Everything can be changed later from the Settings page.'}
      />
      <form onSubmit={submit} className="space-y-8" noValidate>
        <FormSection title={t('setup.form.sectionPanel') || 'Panel'}>
          <Input
            label={t('setup.form.hostname') || 'Panel host name'}
            value={panelHostname}
            onChange={(e) => setPanelHostname(e.target.value)}
            placeholder={t('setup.form.hostnamePlaceholder') || 'panel.example.com'}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="font-mono"
            error={err('panelHostname')}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={t('setup.form.ipv4') || 'Public IPv4'}
              value={ipv4}
              onChange={(e) => setIpv4(e.target.value)}
              placeholder={t('setup.form.ipv4Placeholder') || '203.0.113.10'}
              inputMode="decimal"
              className="font-mono"
              error={err('ipv4')}
            />
            <Input
              label={t('setup.form.ipv6') || 'Public IPv6 (optional)'}
              value={ipv6}
              onChange={(e) => setIpv6(e.target.value)}
              placeholder={t('setup.form.ipv6Placeholder') || '2001:db8::10'}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              className="font-mono"
              error={err('ipv6')}
            />
          </div>
        </FormSection>

        <FormSection title={t('setup.form.sectionDns') || 'DNS'}>
          <p className="text-xs text-text-muted -mt-1">
            {t('setup.form.nsHint') || 'Name servers announced for the hosted domains (they must resolve to this server or to your DNS provider).'}
          </p>
          <div className="space-y-2">
            {nameservers.map((ns, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-[11px] font-mono text-text-muted">{`NS${i + 1}`}</span>
                <input
                  value={ns}
                  onChange={(e) => setNameservers((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
                  placeholder={t('setup.form.nsPlaceholder', { n: i + 1, defaultValue: 'ns{{n}}.example.com' })}
                  aria-label={t('setup.form.nsLabel', { n: i + 1, defaultValue: 'Name server {{n}}' })}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  className="w-full min-w-0 flex-1 rounded-md bg-bg-tertiary px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent coarse:min-h-10"
                />
                {nameservers.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setNameservers((p) => p.filter((_, j) => j !== i))}
                    aria-label={t('setup.form.nsRemove') || 'Remove'}
                    title={t('setup.form.nsRemove') || 'Remove'}
                    className="shrink-0 rounded-md p-2 text-text-muted hover:bg-bg-hover hover:text-status-down transition-colors coarse:min-h-10 coarse:min-w-10"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {err('nameservers') && <p className="text-xs text-status-down">{err('nameservers')}</p>}
          {nameservers.length < 6 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setNameservers((p) => [...p, ''])}>
              <Plus size={14} className="mr-1" />
              {t('setup.form.nsAdd') || 'Add a name server'}
            </Button>
          )}
        </FormSection>

        <FormSection title={t('platformSettings.preview.setupTitle') || 'Preview domain (optional)'}>
          <Input
            label={t('platformSettings.preview.domain') || 'Preview domain'}
            value={previewDomain}
            onChange={(e) => setPreviewDomain(e.target.value)}
            placeholder={t('platformSettings.preview.placeholder') || 'example-preview.net'}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="font-mono"
            error={err('previewDomain')}
          />
          <p className="text-xs text-text-muted -mt-1">
            {t('platformSettings.preview.setupHint') || 'Blue/green previews are served on <site>-<id>.<this domain>. Use a registrable domain distinct from the panel (never a sub-domain of it), so a preview can never read the panel cookies. Leave empty: previews get no public URL until you set it in Settings.'}
          </p>
        </FormSection>

        <FormSection title={t('setup.form.sectionTls') || 'TLS certificates'}>
          <Input
            label={t('setup.form.acmeEmail') || "ACME e-mail (Let's Encrypt)"}
            type="email"
            value={acmeEmail}
            onChange={(e) => setAcmeEmail(e.target.value)}
            placeholder={t('setup.form.emailPlaceholder') || 'admin@example.com'}
            error={err('acmeEmail')}
          />
        </FormSection>

        <FormSection title={t('setup.form.sectionMail') || 'Mail engine'}>
          <p className="text-xs text-text-muted -mt-1">
            {t('setup.form.mailHint') || 'Changing engine later is possible but is a migration, not a switch.'}
          </p>
          <div role="radiogroup" aria-label={t('setup.form.sectionMail') || 'Mail engine'} className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {MAIL_ENGINES.map((m) => {
              const selected = mailEngine === m.id;
              // P4: docker-mailserver / maddy are driver skeletons (shared MAIL_ENGINES_SUPPORTED).
              const supported = isMailEngineSupported(m.id);
              const name = m.id === 'external' ? (t('setup.mail.external.name') || 'None (external)') : m.name;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={!supported}
                  disabled={!supported}
                  title={supported ? undefined : (t('setup.mail.notSupportedHint') || 'This engine is not supported by this version of Oblimint yet.')}
                  onClick={() => { if (supported) setMailEngine(m.id); }}
                  className={cn(
                    'text-left rounded-xl border-2 p-4 transition-all',
                    !supported
                      ? 'border-transparent bg-bg-primary/40 opacity-50 cursor-not-allowed'
                      : selected
                        ? 'border-accent bg-accent/5 shadow-[0_0_0_1px_rgb(var(--c-accent)/0.2)]'
                        : 'border-transparent bg-bg-primary/60 hover:border-accent/30 hover:bg-bg-hover',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                      <Mail size={14} className={selected ? 'text-accent' : 'text-text-muted'} />
                      {name}
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                      {supported
                        ? t('setup.mail.ram', { ram: m.ram, defaultValue: 'RAM {{ram}}' })
                        : (t('setup.mail.notSupported') || 'Not yet supported')}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-text-secondary">
                    <span className="font-semibold text-status-up">+ </span>{t(m.prosKey) || m.prosFallback}
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
                    <span className="font-semibold text-status-down">− </span>{t(m.consKey) || m.consFallback}
                  </p>
                </button>
              );
            })}
          </div>
        </FormSection>

        <FormSection title={t('setup.form.sectionAdmin') || 'Administrator account'}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={t('setup.form.adminUsername') || 'Username'}
              value={adminUsername}
              onChange={(e) => setAdminUsername(e.target.value)}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
              error={err('adminUsername')}
            />
            <Input
              label={t('setup.form.adminEmail') || 'E-mail (optional)'}
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder={t('setup.form.emailPlaceholder') || 'admin@example.com'}
              error={err('adminEmail')}
            />
            <Input
              label={t('setup.form.adminPassword') || 'Password'}
              type="password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              autoComplete="new-password"
              error={err('adminPassword')}
            />
            <Input
              label={t('setup.form.adminPassword2') || 'Confirm password'}
              type="password"
              value={adminPassword2}
              onChange={(e) => setAdminPassword2(e.target.value)}
              autoComplete="new-password"
              error={err('adminPassword2')}
            />
          </div>
        </FormSection>

        <FormSection title={t('setup.form.sectionObligate') || 'Obligate SSO (optional)'}>
          <ToggleSwitch
            checked={useObligate}
            onChange={setUseObligate}
            label={t('setup.form.useObligate') || 'Connect to an Obligate gateway now'}
            description={t('setup.form.useObligateHint') || 'Register Oblimint in Obligate (application type oblimint) and paste its URL and API key. SSO stays disabled until you enable it in Settings.'}
          />
          {useObligate && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label={t('setup.form.obligateUrl') || 'Obligate URL'}
                type="url"
                value={obligateUrl}
                onChange={(e) => setObligateUrl(e.target.value)}
                placeholder={t('settings.obligate.urlPlaceholder') || 'https://obligate.example.com'}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
                error={err('obligateUrl')}
              />
              <Input
                label={t('setup.form.obligateKey') || 'API key'}
                type="password"
                value={obligateKey}
                onChange={(e) => setObligateKey(e.target.value)}
                autoComplete="off"
                className="font-mono"
                error={err('obligateKey')}
              />
            </div>
          )}
        </FormSection>

        {serverError && (
          <div className="rounded-md bg-status-down-bg border border-status-down/30 p-3">
            <p className="text-sm text-status-down">{serverError}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            <ArrowLeft size={14} className="mr-1.5" />
            {t('common.back') || 'Back'}
          </Button>
          <Button type="submit" loading={busy}>
            <Rocket size={14} className="mr-1.5" />
            {t('setup.form.install') || 'Install'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── Step 4: progress ────────────────────────────────────────────────────────

function StepRow({ step }: { step: SetupStep }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(step.status === 'error');
  useEffect(() => { if (step.status === 'error') setOpen(true); }, [step.status]);
  const hasLog = step.log.length > 0;
  const label = t(step.labelKey, { defaultValue: step.id });
  return (
    <li className="rounded-lg bg-bg-primary/60">
      <button
        type="button"
        onClick={() => hasLog && setOpen((v) => !v)}
        aria-expanded={hasLog ? open : undefined}
        className={cn('flex w-full items-center gap-3 px-4 py-3 text-left', hasLog && 'cursor-pointer hover:bg-bg-hover/50 rounded-lg')}
      >
        <StepStatusIcon status={step.status} />
        <span className={cn('flex-1 min-w-0 text-sm', step.status === 'pending' || step.status === 'skipped' ? 'text-text-muted' : 'text-text-primary')}>
          {label}
        </span>
        <span className={cn(
          'text-[10px] font-mono uppercase tracking-[0.14em]',
          step.status === 'done' ? 'text-status-up'
            : step.status === 'error' ? 'text-status-down'
            : step.status === 'running' ? 'text-accent'
            : 'text-text-muted',
        )}>
          {t(`setup.stepStatus.${step.status}`) || step.status}
        </span>
        {hasLog && (open ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />)}
      </button>
      {open && hasLog && (
        <pre className="mx-4 mb-3 max-h-64 overflow-auto rounded-md bg-bg-tertiary px-3 py-2 text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-all">
          {step.log.join('\n')}
        </pre>
      )}
    </li>
  );
}

function ProgressStep({ onDone, onAuthLost, onRetry }: { onDone: () => void; onAuthLost: () => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [pollError, setPollError] = useState(false);
  const doneRef = useRef(false);
  const lastRef = useRef<SetupProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const p = await setupApi.progress();
        if (cancelled) return;
        setProgress(p);
        lastRef.current = p;
        setPollError(false);
        if (p.done && !doneRef.current) {
          doneRef.current = true;
          onDone();
          return;
        }
      } catch (err) {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } } | null)?.response?.status;
        if (status === 401) { onAuthLost(); return; }
        // Network error: the server may already be restarting. When every
        // step had finished, the restart is the expected next stage.
        setPollError(true);
        const last = lastRef.current;
        if (last && !last.error && last.steps.length > 0
          && last.steps.every((st) => st.status === 'done' || st.status === 'skipped') && !doneRef.current) {
          doneRef.current = true;
          onDone();
          return;
        }
      }
      if (!cancelled) timer = setTimeout(tick, PROGRESS_POLL_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const steps = progress?.steps ?? [];
  const finished = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const pct = steps.length > 0 ? Math.round((finished / steps.length) * 100) : 0;

  return (
    <Card>
      <SectionTitle
        title={t('setup.progress.title') || 'Installation'}
        subtitle={t('setup.progress.subtitle') || 'Do not close this page.'}
      />
      <div className="mb-4">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">
            {t('setup.progress.count', { done: finished, total: steps.length, defaultValue: '{{done}} / {{total}} steps' })}
          </span>
          <span className="font-display text-2xl font-semibold text-accent leading-none">{pct}%</span>
        </div>
        <div className="h-1 w-full rounded bg-white/[0.04]">
          <div className="h-full rounded bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {progress?.error && (
        <div className="mb-4 rounded-md bg-status-down-bg border border-status-down/30 p-3 space-y-2">
          <p className="text-sm font-medium text-status-down">{t('setup.progress.failed') || 'The installation failed.'}</p>
          <p className="text-xs font-mono text-status-down break-all">{progress.error}</p>
          <p className="text-xs text-text-secondary">{t('setup.progress.failedHint') || 'Read the logs of the failed step, fix the cause, then restart the container to run the wizard again.'}</p>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw size={14} className="mr-1.5" />
            {t('setup.progress.backToChecks') || 'Back to the host checks'}
          </Button>
        </div>
      )}

      {pollError && !progress?.error && (
        <p className="mb-3 text-xs text-status-pending">{t('setup.progress.unreachable') || 'The server does not answer right now; retrying…'}</p>
      )}

      {steps.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
          <Loader2 size={16} className="animate-spin" />
          {t('setup.progress.starting') || 'Starting…'}
        </div>
      ) : (
        <ul className="space-y-2">
          {steps.map((s) => <StepRow key={s.id} step={s} />)}
        </ul>
      )}
    </Card>
  );
}

// ── Step 5: restart ─────────────────────────────────────────────────────────

function RestartingStep() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'waiting' | 'up'>('waiting');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Give the server time to exit (process.exit 3 s after `done`).
    const start = Date.now();
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - start > 3000 && await setupApi.health()) {
        try {
          const mode = await setupApi.status();
          if (mode === 'normal') {
            setPhase('up');
            setSetupToken(null);
            // Full reload: the app boots again and picks the normal routes.
            setTimeout(() => { window.location.replace('/login'); }, 800);
            return;
          }
        } catch { /* still restarting */ }
      }
      if (!cancelled) timer = setTimeout(tick, RESTART_POLL_MS);
    };
    timer = setTimeout(tick, RESTART_POLL_MS);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  return (
    <Card className="text-center">
      <div className="flex flex-col items-center gap-4 py-6">
        {phase === 'waiting'
          ? <Loader2 size={40} className="animate-spin text-accent" />
          : <CheckCircle2 size={40} className="text-status-up" />}
        <h2 className="font-display text-xl font-semibold tracking-wide text-text-primary">
          {phase === 'waiting' ? (t('setup.restart.title') || 'Restarting…') : (t('setup.restart.ready') || 'Oblimint is ready')}
        </h2>
        <p className="max-w-md text-sm text-text-secondary">
          {phase === 'waiting'
            ? (t('setup.restart.body') || 'The configuration is saved. Oblimint restarts in normal mode; this page will take you to the sign-in page as soon as it answers.')
            : (t('setup.restart.redirecting') || 'Redirecting to the sign-in page…')}
        </p>
      </div>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

/**
 * First-run setup wizard (docs/P0-PLAN.md §Setup). Shown instead of every
 * route while `GET /api/setup/status` answers `setup`.
 */
export function SetupWizardPage() {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep | null>(null);

  const onAuthLost = useCallback(() => {
    setSetupToken(null);
    setStep('token');
    toast.error(t('setup.token.expired') || 'The setup token is no longer valid. Enter it again.');
  }, [t]);

  // Resume: a token in sessionStorage + an installation already started → progress.
  useEffect(() => {
    if (!getSetupToken()) { setStep('token'); return; }
    setupApi.progress()
      .then((p) => setStep(p.done ? 'restarting' : p.started ? 'progress' : 'checks'))
      .catch((err) => {
        const status = (err as { response?: { status?: number } } | null)?.response?.status;
        if (status === 401) { setSetupToken(null); setStep('token'); } else setStep('checks');
      });
  }, []);

  return (
    <div className="min-h-dvh supports-[not(height:100dvh)]:min-h-screen bg-bg-primary px-4 py-8 pt-[max(2rem,var(--safe-top))] pb-[max(2rem,var(--safe-bottom))]">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="flex flex-col items-center text-center gap-2">
          <Logo className="h-16 w-auto max-w-[220px] object-contain" />
          <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
            {t('setup.title') || 'Initial setup'}
          </h1>
          <p className="text-xs font-mono tracking-wider text-text-muted">
            {t('setup.subtitle') || 'Configure this server in a few steps.'}
          </p>
        </div>

        {step && <div className="flex justify-center"><StepHeader step={step} /></div>}

        {step === null ? (
          <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-text-muted" /></div>
        ) : step === 'token' ? (
          <TokenStep onDone={() => setStep('checks')} />
        ) : step === 'checks' ? (
          <ChecksStep onNext={() => setStep('form')} onAuthLost={onAuthLost} />
        ) : step === 'form' ? (
          <SetupForm onApplied={() => setStep('progress')} onBack={() => setStep('checks')} onAuthLost={onAuthLost} />
        ) : step === 'progress' ? (
          <ProgressStep onDone={() => setStep('restarting')} onAuthLost={onAuthLost} onRetry={() => setStep('checks')} />
        ) : (
          <RestartingStep />
        )}

        <p className="text-center text-xs text-text-secondary/50 select-none">
          {t('login.clientVersion', { version: __APP_VERSION__, defaultValue: 'Client v{{version}}' })}
        </p>
      </div>
    </div>
  );
}
