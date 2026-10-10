import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import type { AdvancedConfigLintResult, ProxyHeaderRule, ProxyHostOptions } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { Pill, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { FormSection } from '../proxyUi';
import {
  PROXY_HOST_LIMITS, isAllowedResponseHeader, isAllowedUpstreamHeader, isValidHeaderValue, isValidHostname, isValidBaitPath, isValidOrigin, linesOf,
} from '../proxyFormat';
import { proxyErrorMessage } from '../proxyErrors';
import { NumField } from './fields';
import type { HostForm } from './hostEditorModel';
import type { TabProps } from './HostTabsMain';

// ── Honeypot ────────────────────────────────────────────────────────────────

const BAN_DURATIONS: Array<number | null> = [null, 60, 1440, 10080, 43200];

export function HoneypotTab({ form, set, refs, readOnly }: TabProps) {
  const { t } = useTranslation();
  const hp = form.honeypot;
  const patch = (p: Partial<HostForm['honeypot']>) => set({ honeypot: { ...hp, ...p } });
  const [text, setText] = useState(hp.paths.join('\n'));
  const routePaths = new Set(form.routes.map((r) => r.path.trim()));
  const invalid = linesOf(text).filter((p) => !isValidBaitPath(p));
  const shadowed = hp.paths.filter((p) => routePaths.has(p));

  const applyText = (v: string) => {
    setText(v);
    patch({ paths: linesOf(v).filter(isValidBaitPath) });
  };
  const addPresets = () => {
    const merged = [...new Set([...linesOf(text), ...refs.presets.map((p) => p.path)])];
    applyText(merged.join('\n'));
  };
  const durationLabel = (m: number | null) => {
    switch (m) {
      case null: return t('proxy.honeypot.durationDefault') || 'Escalation of the platform (default)';
      case 60: return t('proxy.honeypot.duration1h') || '1 hour';
      case 1440: return t('proxy.honeypot.duration24h') || '24 hours';
      case 10080: return t('proxy.honeypot.duration7d') || '7 days';
      default: return t('proxy.honeypot.duration30d') || '30 days';
    }
  };

  return (
    <div className="space-y-4">
      <FormSection title={t('proxy.honeypot.title') || 'Honeypot'} description={t('proxy.honeypot.description') || 'Requests on bait paths (scanners looking for /wp-login.php, /.env…) answer 404 and ban the address on every host of the account; repeat offences ban longer.'}>
        <ToggleSwitch checked={hp.enabled} disabled={readOnly} onChange={(v) => patch({ enabled: v })} label={t('proxy.honeypot.enabled') || 'Honeypot enabled'} />
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <label className="text-xs text-text-muted" htmlFor="hp-paths">{t('proxy.honeypot.paths') || 'Bait paths (one per line, prefixes)'}</label>
            <span className="font-mono text-[11px] text-text-muted">{hp.paths.length}</span>
            {!readOnly && (
              <Button size="sm" variant="ghost" className="ml-auto" disabled={refs.presets.length === 0} onClick={addPresets}>
                <Sparkles size={13} className="mr-1.5" />{t('proxy.honeypot.addPresets') || 'Add the common exploit URLs'}
              </Button>
            )}
          </div>
          <textarea id="hp-paths" value={text} disabled={readOnly} onChange={(e) => applyText(e.target.value)} rows={8} spellCheck={false}
            placeholder={'/wp-login.php\n/.env\n/.git/config'} className={cn(inputCls, 'resize-y font-mono text-xs', invalid.length > 0 && 'ring-2 ring-status-down/50')} />
          {invalid.length > 0 && <p className="mt-1 text-[11px] text-status-down">{t('proxy.honeypot.invalidPaths', { paths: invalid.slice(0, 3).join(' '), defaultValue: 'Ignored (invalid): {{paths}}' })}</p>}
          {shadowed.length > 0 && <p className="mt-1 text-[11px] text-amber-400">{t('proxy.honeypot.shadowed', { paths: shadowed.join(' '), defaultValue: 'A sub-route uses {{paths}}: the bait is ignored there.' })}</p>}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ToggleSwitch checked={hp.banAclViolations} disabled={readOnly} onChange={(v) => patch({ banAclViolations: v })} label={t('proxy.honeypot.banAcl') || 'Ban IP access-list violations'}
            description={t('proxy.honeypot.banAclHint') || 'An address refused by the IP rules gets a 404 (it never learns a list exists) and is banned. Never for password-only lists.'} />
          <div>
            <label className={labelCls} htmlFor="hp-duration">{t('proxy.honeypot.duration') || 'Ban duration'}</label>
            <select id="hp-duration" value={hp.banDurationMinutes ?? ''} disabled={readOnly} onChange={(e) => patch({ banDurationMinutes: e.target.value ? Number(e.target.value) : null })} className={selectCls}>
              {BAN_DURATIONS.map((m) => <option key={m ?? 'd'} value={m ?? ''}>{durationLabel(m)}</option>)}
              {hp.banDurationMinutes != null && !BAN_DURATIONS.includes(hp.banDurationMinutes) && <option value={hp.banDurationMinutes}>{hp.banDurationMinutes} min</option>}
            </select>
            <p className="mt-1 text-[11px] text-text-muted">{t('proxy.honeypot.durationHint') || 'First ban at least this long; repeat offences follow the escalation ladder.'}</p>
          </div>
        </div>
      </FormSection>
    </div>
  );
}

// ── Performance ─────────────────────────────────────────────────────────────

export function PerformanceTab({ form, set, readOnly }: TabProps) {
  const { t } = useTranslation();
  const o = form.options;
  const patch = (p: Partial<ProxyHostOptions>) => set({ options: { ...o, ...p } });
  const sec = t('proxy.editor.seconds') || 's';
  return (
    <div className="space-y-4">
      <FormSection title={t('proxy.editor.protocol') || 'Protocol and compression'}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ToggleSwitch checked={o.websocket} disabled={readOnly} onChange={(v) => patch({ websocket: v })} label="WebSocket" description={t('proxy.editor.websocketHint') || 'Upgrade headers passed to the target.'} />
          <ToggleSwitch checked={o.gzip} disabled={readOnly} onChange={(v) => patch({ gzip: v })} label="Gzip" description={t('proxy.editor.gzipHint') || 'Compress text responses.'} />
          <ToggleSwitch checked={o.cache} disabled={readOnly} onChange={(v) => patch({ cache: v })} label={t('proxy.editor.cache') || 'Cache static assets'} description={t('proxy.editor.cacheHint') || 'Images, CSS, JS kept 1 day by the edge (X-Cache-Status header).'} />
          <ToggleSwitch checked={o.buffering} disabled={readOnly} onChange={(v) => patch({ buffering: v })} label={t('proxy.editor.buffering') || 'Buffering'} description={t('proxy.editor.bufferingHint') || 'Off for streaming responses (server-sent events…).'} />
          <ToggleSwitch checked={o.requestBuffering} disabled={readOnly} onChange={(v) => patch({ requestBuffering: v })} label={t('proxy.editor.requestBuffering') || 'Request buffering'} description={t('proxy.editor.requestBufferingHint') || 'Off for large uploads streamed to the target.'} />
        </div>
      </FormSection>
      <FormSection title="CORS">
        <ToggleSwitch checked={o.cors} disabled={readOnly} onChange={(v) => patch({ cors: v })} label={t('proxy.editor.cors') || 'Add the CORS headers'} description={t('proxy.editor.corsHint') || 'Without origin: * and OPTIONS answered 204. With origins: only those.'} />
        {o.cors && (
          <div>
            <label className={labelCls} htmlFor="ph-origins">{t('proxy.editor.corsOrigins') || 'Allowed origins'}</label>
            <ChipsInput id="ph-origins" value={o.corsOrigins} onChange={(v) => patch({ corsOrigins: v })} validate={isValidOrigin} normalize={(v) => v.toLowerCase().replace(/\/$/, '')} max={PROXY_HOST_LIMITS.corsOrigins} disabled={readOnly} placeholder="https://app.example.com" ariaLabel={t('proxy.editor.corsOrigins') || 'Allowed origins'} />
          </div>
        )}
      </FormSection>
      <FormSection title={t('proxy.editor.limits') || 'Sizes and timeouts'}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumField id="ph-body" label={t('proxy.editor.bodySize') || 'Max body size'} suffix={t('proxy.editor.mb') || 'MiB'} value={o.bodySizeMb} allowEmpty min={1} max={PROXY_HOST_LIMITS.bodySizeMb} placeholder={t('proxy.editor.default') || 'default'} disabled={readOnly} onChange={(v) => patch({ bodySizeMb: v })} />
          <NumField id="ph-ct" label={t('proxy.editor.connectTimeout') || 'Connect timeout'} suffix={sec} value={o.connectTimeoutSec} min={1} max={PROXY_HOST_LIMITS.connectTimeoutSec} disabled={readOnly} onChange={(v) => patch({ connectTimeoutSec: v ?? 10 })} />
          <NumField id="ph-st" label={t('proxy.editor.sendTimeout') || 'Send timeout'} suffix={sec} value={o.sendTimeoutSec} min={1} max={PROXY_HOST_LIMITS.timeoutSec} disabled={readOnly} onChange={(v) => patch({ sendTimeoutSec: v ?? 60 })} />
          <NumField id="ph-rt" label={t('proxy.editor.readTimeout') || 'Read timeout'} suffix={sec} value={o.readTimeoutSec} min={1} max={PROXY_HOST_LIMITS.timeoutSec} disabled={readOnly} onChange={(v) => patch({ readTimeoutSec: v ?? 60 })} />
        </div>
        <p className="text-[11px] text-text-muted">{t('proxy.editor.bodySizeHint') || 'Empty body size = platform default; the platform also caps it.'}</p>
      </FormSection>
      <FormSection title={t('proxy.editor.rateLimit') || 'Rate limit'}>
        <ToggleSwitch checked={o.rateLimit != null} disabled={readOnly} onChange={(v) => patch({ rateLimit: v ? { rps: 10, burst: 20 } : null })} label={t('proxy.editor.rateLimitOn') || 'Limit the requests per client address'} description={t('proxy.editor.rateLimitHint') || 'Beyond the rate (plus the burst), requests are refused with 503.'} />
        {o.rateLimit && (
          <div className="grid grid-cols-2 gap-3 sm:w-96">
            <NumField id="ph-rps" label={t('proxy.editor.rps') || 'Requests / second'} value={o.rateLimit.rps} min={1} max={PROXY_HOST_LIMITS.rps} disabled={readOnly} onChange={(v) => patch({ rateLimit: { ...o.rateLimit!, rps: v ?? 1 } })} />
            <NumField id="ph-burst" label={t('proxy.editor.burst') || 'Burst'} value={o.rateLimit.burst} min={0} max={PROXY_HOST_LIMITS.burst} disabled={readOnly} onChange={(v) => patch({ rateLimit: { ...o.rateLimit!, burst: v ?? 0 } })} />
          </div>
        )}
      </FormSection>
    </div>
  );
}

// ── Others ──────────────────────────────────────────────────────────────────

export function OthersTab({ form, set, refs, readOnly }: TabProps) {
  const { t } = useTranslation();
  const o = form.options;
  const patch = (p: Partial<ProxyHostOptions>) => set({ options: { ...o, ...p } });
  const usable = refs.pages.filter((p) => p.accountId == null || p.accountId === form.accountId);
  const errorPages = usable.filter((p) => !p.isWakingPage);
  const wakingPages = usable.filter((p) => p.isWakingPage);
  const setHeader = (i: number, p: Partial<ProxyHeaderRule>) => patch({ headers: o.headers.map((h, j) => (j === i ? { ...h, ...p } : h)) });
  const setUp = (i: number, p: Partial<{ name: string; value: string }>) => patch({ upstreamHeaders: o.upstreamHeaders.map((h, j) => (j === i ? { ...h, ...p } : h)) });
  const pageLabel = (p: (typeof usable)[number]) => `${p.name}${p.accountId == null ? ` (${t('proxy.pages.platform') || 'platform'})` : ''}`;
  return (
    <div className="space-y-4">
      <FormSection title={t('proxy.tabs.pages') || 'Pages'}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="ph-errpage">{t('proxy.editor.errorPage') || 'Error page'}</label>
            <select id="ph-errpage" value={o.errorPageId ?? ''} disabled={readOnly} onChange={(e) => patch({ errorPageId: e.target.value ? Number(e.target.value) : null })} className={selectCls}>
              <option value="">{t('proxy.pages.platformDefault') || 'Default page'}</option>
              {errorPages.map((p) => <option key={p.id} value={p.id}>{pageLabel(p)}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ph-wakepage">{t('proxy.editor.wakingPage') || 'Waking page (sleeping application)'}</label>
            <select id="ph-wakepage" value={o.wakingPageId ?? ''} disabled={readOnly} onChange={(e) => patch({ wakingPageId: e.target.value ? Number(e.target.value) : null })} className={selectCls}>
              <option value="">{t('proxy.pages.platformDefault') || 'Default page'}</option>
              {wakingPages.map((p) => <option key={p.id} value={p.id}>{pageLabel(p)}</option>)}
            </select>
          </div>
        </div>
      </FormSection>

      <FormSection
        title={t('proxy.editor.responseHeaders') || 'Response headers'}
        actions={!readOnly ? <Button size="sm" variant="ghost" onClick={() => patch({ headers: [...o.headers, { action: 'add', name: '', value: '' }] })}><Plus size={13} className="mr-1" />{t('proxy.editor.addHeader') || 'Add'}</Button> : undefined}
      >
        {o.headers.length === 0 ? <p className="text-xs text-text-muted">{t('proxy.editor.noHeader') || 'No header rule.'}</p> : (
          <ul className="space-y-1.5">
            {o.headers.map((h, i) => (
              <li key={i} className="grid grid-cols-[6.5rem_1fr_auto] gap-2 sm:grid-cols-[7rem_1fr_1fr_auto]">
                <select aria-label={t('proxy.accessLists.action') || 'Action'} value={h.action} disabled={readOnly} onChange={(e) => setHeader(i, { action: e.target.value as ProxyHeaderRule['action'] })} className={selectCls}>
                  <option value="add">{t('proxy.editor.headerAdd') || 'add'}</option>
                  <option value="remove">{t('proxy.editor.headerRemove') || 'remove'}</option>
                </select>
                <input aria-label={t('proxy.editor.headerName') || 'Name'} value={h.name} disabled={readOnly} onChange={(e) => setHeader(i, { name: e.target.value })} placeholder="X-Frame-Options" spellCheck={false}
                  className={cn(inputCls, 'font-mono text-xs', h.name && !isAllowedResponseHeader(h.name) && 'ring-2 ring-status-down/50')} />
                <IconButton className="sm:order-last" label={t('common.delete') || 'Delete'} icon={<X size={14} />} size="sm" disabled={readOnly} onClick={() => patch({ headers: o.headers.filter((_, j) => j !== i) })} />
                {h.action === 'add' ? (
                  <input aria-label={t('proxy.editor.headerValue') || 'Value'} value={h.value} disabled={readOnly} onChange={(e) => setHeader(i, { value: e.target.value })} placeholder="SAMEORIGIN" spellCheck={false}
                    className={cn(inputCls, 'col-span-3 font-mono text-xs sm:col-span-1', !isValidHeaderValue(h.value) && 'ring-2 ring-status-down/50')} />
                ) : <span className="hidden sm:block" />}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-text-muted">{t('proxy.editor.headersHint') || 'Add: sent on every response (always). Remove: hides a header sent by the target.'}</p>
      </FormSection>

      <FormSection
        title={t('proxy.editor.upstream') || 'Towards the target'}
        actions={!readOnly ? <Button size="sm" variant="ghost" onClick={() => patch({ upstreamHeaders: [...o.upstreamHeaders, { name: '', value: '' }] })}><Plus size={13} className="mr-1" />{t('proxy.editor.addUpstreamHeader') || 'Request header'}</Button> : undefined}
      >
        {o.upstreamHeaders.length > 0 && (
          <ul className="space-y-1.5">
            {o.upstreamHeaders.map((h, i) => (
              <li key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input aria-label={t('proxy.editor.headerName') || 'Name'} value={h.name} disabled={readOnly} onChange={(e) => setUp(i, { name: e.target.value })} placeholder="X-Forwarded-Prefix" spellCheck={false}
                  className={cn(inputCls, 'font-mono text-xs', h.name && !isAllowedUpstreamHeader(h.name) && 'ring-2 ring-status-down/50')} />
                <IconButton className="sm:order-last" label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} size="sm" disabled={readOnly} onClick={() => patch({ upstreamHeaders: o.upstreamHeaders.filter((_, j) => j !== i) })} />
                <input aria-label={t('proxy.editor.headerValue') || 'Value'} value={h.value} disabled={readOnly} onChange={(e) => setUp(i, { value: e.target.value })} spellCheck={false}
                  className={cn(inputCls, 'col-span-2 font-mono text-xs sm:col-span-1', !isValidHeaderValue(h.value) && 'ring-2 ring-status-down/50')} />
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ToggleSwitch checked={o.preserveHost} disabled={readOnly} onChange={(v) => patch({ preserveHost: v, upstreamHostHeader: v ? null : o.upstreamHostHeader })} label={t('proxy.editor.preserveHost') || 'Keep the Host of the request'} description={t('proxy.editor.preserveHostHint') || 'Off: send the Host below (or the target host).'} />
          {!o.preserveHost && (
            <div>
              <label className={labelCls} htmlFor="ph-hosthdr">{t('proxy.editor.hostOverride') || 'Host sent to the target'}</label>
              <input id="ph-hosthdr" value={o.upstreamHostHeader ?? ''} disabled={readOnly} onChange={(e) => patch({ upstreamHostHeader: e.target.value.trim().toLowerCase() || null })} placeholder="internal.example.net" spellCheck={false}
                className={cn(inputCls, 'font-mono', o.upstreamHostHeader && !isValidHostname(o.upstreamHostHeader) && 'ring-2 ring-status-down/50')} />
            </div>
          )}
          <ToggleSwitch checked={o.upstreamTlsVerify} disabled={readOnly} onChange={(v) => patch({ upstreamTlsVerify: v })} label={t('proxy.editor.tlsVerify') || 'Verify the target certificate (https)'} />
          <ToggleSwitch checked={o.skipUpstreamCheck} disabled={readOnly} onChange={(v) => patch({ skipUpstreamCheck: v })} label={t('proxy.editor.skipCheck') || 'Skip the reachability check'} description={t('proxy.editor.skipCheckHint') || 'Apply even when the target does not answer yet (it is probed otherwise).'} />
        </div>
      </FormSection>

      <FormSection title={t('proxy.editor.security') || 'Security'}>
        <ToggleSwitch checked={o.blockExploits} disabled={readOnly} onChange={(v) => patch({ blockExploits: v })} label={t('proxy.editor.blockExploits') || 'Block common exploits'} description={t('proxy.editor.blockExploitsHint') || 'SQL injection, path traversal and scanner patterns answered 403.'} />
      </FormSection>
    </div>
  );
}

// ── Expert (platform staff) ─────────────────────────────────────────────────

export function ExpertTab({ form, set, readOnly, serverIssues }: TabProps & { serverIssues: AdvancedConfigLintResult['issues'] }) {
  const { t } = useTranslation();
  const [lint, setLint] = useState<AdvancedConfigLintResult | null>(null);
  const [linting, setLinting] = useState(false);
  const [lintError, setLintError] = useState<string | null>(null);
  const size = new Blob([form.advancedConfig]).size;
  const issues = lint?.issues ?? serverIssues;

  const runLint = async () => {
    setLinting(true);
    setLintError(null);
    try {
      setLint(await proxyApi.lintAdvancedConfig(form.advancedConfig));
    } catch (err) {
      setLint(null);
      setLintError(proxyErrorMessage(t, err, t('proxy.expert.lintFailed') || 'The check failed'));
    } finally {
      setLinting(false);
    }
  };

  return (
    <FormSection title={t('proxy.expert.title') || 'Advanced configuration'} description={t('proxy.expert.description') || 'Raw nginx directives added at the end of the server block. Platform staff only: checked against an allow-list, then tested in isolation; a refused version is quarantined and never breaks the other hosts.'}>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <label className="text-xs text-text-muted" htmlFor="ph-adv">nginx</label>
          <span className={cn('ml-auto font-mono text-[11px]', size > 16 * 1024 ? 'text-status-down' : 'text-text-muted')}>{Math.ceil(size / 1024)} / 16 KiB</span>
        </div>
        <textarea id="ph-adv" value={form.advancedConfig} disabled={readOnly} onChange={(e) => { set({ advancedConfig: e.target.value }); setLint(null); }} rows={14} spellCheck={false}
          placeholder={'# proxy_read_timeout 300s;\n# add_header X-Robots-Tag "noindex" always;'} className={cn(inputCls, 'min-h-[14rem] resize-y font-mono text-xs leading-relaxed')} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" loading={linting} disabled={readOnly || !form.advancedConfig.trim()} onClick={() => { void runLint(); }}>{t('proxy.expert.lint') || 'Check'}</Button>
        {lint?.ok && <Pill tone="green"><CheckCircle2 size={10} />{t('proxy.expert.ok') || 'accepted'}</Pill>}
        {lintError && <span className="text-xs text-status-down">{lintError}</span>}
      </div>
      {issues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-status-down/5 p-2.5">
          {issues.map((i, n) => (
            <li key={n} className="flex items-start gap-2 text-xs">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-status-down" />
              <span className="font-mono text-text-muted">{t('proxy.expert.line', { line: i.line, defaultValue: 'line {{line}}' })}</span>
              {i.directive && <span className="font-mono text-text-primary">{i.directive}</span>}
              <span className="text-text-secondary">{i.message}</span>
            </li>
          ))}
        </ul>
      )}
    </FormSection>
  );
}
