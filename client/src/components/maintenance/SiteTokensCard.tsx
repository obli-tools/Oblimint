import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { Site, SiteApiToken, SiteApiTokenCreated } from '@oblimint/shared';
import { siteTokensApi } from '@/api/maintenance.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, CopyButton, inputCls, isStepUpHandled, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { curlOpenExample } from './maintenanceFormat';
import { isNotImplemented, maintenanceErrorMessage, toastMaintenanceError } from './maintenanceErrors';

const EXPIRY_DAYS = [0, 7, 30, 90, 365] as const;
const TOKEN_LIMIT = 10;

/** API tokens of the site (scope `windows`: open / extend / close / status — never validate). Needs sites.manage. */
export function SiteTokensCard({ site }: { site: Site }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<SiteApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<SiteApiTokenCreated | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await siteTokensApi.list(site.id));
      setError(null);
    } catch (err) {
      setTokens([]);
      setError(isNotImplemented(err) ? (t('maintenance.notAvailable') || 'Not available on this server yet.') : maintenanceErrorMessage(err, t, t('siteTokens.loadFailed') || 'Failed to load the API tokens'));
    }
  }, [site.id, t]);
  useEffect(() => { void load(); }, [load]);

  const revoke = async (tok: SiteApiToken) => {
    if (!(await confirm({
      title: t('siteTokens.revokeTitle') || 'Revoke the token',
      message: t('siteTokens.revokeConfirm', { name: tok.name, defaultValue: 'Revoke « {{name}} »? Scripts using it will get 401 errors.' }),
      confirmLabel: t('siteTokens.revoke') || 'Revoke',
      danger: true,
    }))) return;
    setBusy(tok.id);
    try {
      await siteTokensApi.delete(site.id, tok.id);
      setTokens((cur) => (cur ?? []).filter((x) => x.id !== tok.id));
      toast.success(t('siteTokens.revoked') || 'Token revoked');
    } catch (err) {
      toastMaintenanceError(err, t, t('siteTokens.revokeFailed') || 'Failed to revoke the token');
    } finally {
      setBusy(null);
    }
  };

  const count = tokens?.length ?? 0;
  return (
    <Card
      title={t('siteTokens.title') || 'API tokens'}
      icon={<KeyRound size={14} className="text-accent" />}
      actions={!error ? (
        <Button size="sm" variant="secondary" disabled={tokens === null || count >= TOKEN_LIMIT} onClick={() => setCreating(true)}>
          <Plus size={13} className="mr-1.5" />{t('siteTokens.create') || 'New token'}
        </Button>
      ) : undefined}
    >
      <p className="mb-3 text-xs text-text-muted">
        {t('siteTokens.explain') || 'A token lets a script or a CI pipeline open, extend and close a window of this site (never validate nor reject it). Up to 10 tokens per site.'}
      </p>
      {error ? (
        <p className="text-xs text-text-muted">{error}</p>
      ) : tokens === null ? null : tokens.length === 0 ? (
        <p className="text-sm text-text-muted">{t('siteTokens.empty') || 'No token.'}</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {tokens.map((tok) => {
            const expired = tok.expiresAt != null && new Date(tok.expiresAt).getTime() < Date.now();
            return (
              <li key={tok.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{tok.name}</span>
                    <code className="font-mono text-[11px] text-text-muted">{tok.prefix}…</code>
                    {expired && <span className="text-[11px] text-red-400">{t('siteTokens.expired') || 'expired'}</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                    <span>{t('siteTokens.createdBy', { name: tok.createdByName ?? '—', date: formatDateTime(tok.createdAt, i18n.language), defaultValue: 'by {{name}}, {{date}}' })}</span>
                    <span>{t('siteTokens.lastUsed', { date: formatDateTime(tok.lastUsedAt, i18n.language), defaultValue: 'last used: {{date}}' })}</span>
                    <span>{t('siteTokens.expires', { date: tok.expiresAt ? formatDateTime(tok.expiresAt, i18n.language) : (t('siteTokens.never') || 'never'), defaultValue: 'expires: {{date}}' })}</span>
                  </div>
                </div>
                <IconButton variant="danger" label={t('siteTokens.revoke') || 'Revoke'} icon={<Trash2 size={14} />} disabled={busy === tok.id} onClick={() => { void revoke(tok); }} />
              </li>
            );
          })}
        </ul>
      )}

      <CreateTokenModal
        open={creating}
        siteId={site.id}
        onClose={() => setCreating(false)}
        onCreated={(tok) => {
          setCreating(false);
          setCreated(tok);
          // The secret stays only in `created` (cleared when the "shown once" modal closes, M6).
          const { token: _secret, ...meta } = tok;
          setTokens((cur) => [...(cur ?? []), meta]);
        }}
      />
      <TokenShownOnceModal token={created} onClose={() => setCreated(null)} />
    </Card>
  );
}

function CreateTokenModal({ open, siteId, onClose, onCreated }: { open: boolean; siteId: number; onClose: () => void; onCreated: (tok: SiteApiTokenCreated) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(90);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (open) { setName(''); setDays(90); setError(''); } }, [open]);

  const expiryLabel = (d: number) => (d === 0
    ? (t('siteTokens.noExpiry') || 'No expiry')
    : t('siteTokens.days', { count: d, defaultValue: '{{count}} days' }));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    setSaving(true);
    setError('');
    try {
      const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
      onCreated(await siteTokensApi.create(siteId, { name: name.trim(), expiresAt }));
    } catch (err) {
      if (!isStepUpHandled(err)) setError(maintenanceErrorMessage(err, t, t('siteTokens.createFailed') || 'Failed to create the token'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('siteTokens.createTitle') || 'New API token'}
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      size="md"
      footer={(
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      )}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label className={labelCls} htmlFor="tok-name">{t('siteTokens.name') || 'Name'}</label>
          <input id="tok-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus placeholder={t('siteTokens.namePlaceholder') || 'deploy-ci'} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="tok-expiry">{t('siteTokens.expiry') || 'Expiry'}</label>
          <select id="tok-expiry" value={days} onChange={(e) => setDays(Number(e.target.value))} className={selectCls}>
            {EXPIRY_DAYS.map((d) => <option key={d} value={d}>{expiryLabel(d)}</option>)}
          </select>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** The secret is shown once, with a copy button and a curl example. */
function TokenShownOnceModal({ token, onClose }: { token: SiteApiTokenCreated | null; onClose: () => void }) {
  const { t } = useTranslation();
  const curl = token ? curlOpenExample(window.location.origin, token.token) : '';
  return (
    <Modal
      open={token !== null}
      onClose={onClose}
      title={t('siteTokens.createdTitle') || 'Token created'}
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      size="lg"
      closeOnBackdrop={false}
      footer={<Button size="sm" onClick={onClose}>{t('siteTokens.done') || 'I copied it'}</Button>}
    >
      {token && (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {t('siteTokens.onceWarning') || 'Copy the token now: it is shown only once and cannot be read again (only its fingerprint is stored).'}
          </p>
          <div className="flex items-center gap-2 rounded-lg bg-bg-primary p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-sm text-text-primary">{token.token}</code>
            <CopyButton text={token.token} />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs text-text-muted">
              <span className="flex-1">{t('siteTokens.curlTitle') || 'Open a 30-minute window from a script:'}</span>
              <CopyButton text={curl} />
            </div>
            <pre className="overflow-x-auto rounded-lg bg-bg-primary p-3 font-mono text-[12px] leading-relaxed text-text-secondary">{curl}</pre>
            <p className="mt-2 text-xs text-text-muted">
              {t('siteTokens.curlHint') || 'Other calls: GET /api/site-api/window (status), POST /api/site-api/window/extend {"minutes": 30}, POST /api/site-api/window/close.'}
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}
