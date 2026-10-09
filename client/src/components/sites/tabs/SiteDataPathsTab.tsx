import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Info, Pencil, Plus, Rocket, Trash2, Wand2 } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  appProfileDef, normalizeRelPath, type DataPathPolicy, type SiteDataPath,
} from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ExtensionChips } from '../ExtensionChips';
import { Pill, PolicyBadge, usePolicyLabel } from '../SiteBadges';
import { dataPathContainsDocroot, findOverlappingPath, isPhpLikeExtension } from '../siteForm';
import { siteErrorMessage, toastSiteError } from '../siteErrors';
import { fieldCls, labelCls, sectionLabelCls, tdCls, thCls } from '../styles';
import type { SiteTabProps } from './types';

export function SiteDataPathsTab({ site, onPublish }: SiteTabProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const canPublish = can('releases.publish', site.accountId);
  const policyLabel = usePolicyLabel();

  const [paths, setPaths] = useState<SiteDataPath[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<SiteDataPath | 'new' | null>(null);
  const [applying, setApplying] = useState(false);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      setPaths(await sitesApi.dataPaths(site.id));
      setError('');
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [site.id, t]);

  useEffect(() => { void load(); }, [load]);

  const remove = async (p: SiteDataPath) => {
    if (!(await confirm({
      message: t('dataPaths.deleteConfirm', { path: p.path, defaultValue: 'Remove the data path {{path}}/? From the next publication it will come from the release again (read only). The files already in /data are kept.' }),
      danger: true,
    }))) return;
    try {
      await sitesApi.deleteDataPath(site.id, p.id);
      toast.success(t('dataPaths.deleted') || 'Data path removed');
      setChanged(true);
      await load();
    } catch (err) {
      toastSiteError(err, t);
    }
  };

  const applyProfile = async () => {
    if (!site.appProfile) return;
    setApplying(true);
    try {
      setPaths(await sitesApi.applyProfile(site.id, site.appProfile));
      toast.success(t('dataPaths.profileApplied') || 'Profile data paths applied');
      setChanged(true);
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setApplying(false);
    }
  };

  const profileName = site.appProfile ? (site.appProfile === 'static' ? (t('sites.profile.static') || 'Static site') : appProfileDef(site.appProfile).label) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-bg-secondary px-4 py-3 text-xs text-text-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p>
          {t('dataPaths.explain', { slug: site.slug, defaultValue: 'The code is read only. Data paths are the only writable folders: in the release they point to /data/{{slug}}/<path>, where the application writes (uploads, caches…). PHP is never executed there.' })}
        </p>
      </div>

      {(changed) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-400">
          <span className="min-w-0 flex-1">{t('dataPaths.nextPublication') || 'Changes take effect at the next publication.'}</span>
          {canPublish && (
            <Button size="sm" onClick={onPublish}>
              <Rocket size={14} className="mr-1" />{t('dataPaths.publishNow') || 'Publish now'}
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {canManage && (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void applyProfile()}
              loading={applying}
              disabled={!site.appProfile}
              title={site.appProfile ? undefined : (t('dataPaths.noProfile') || 'Choose an application profile in the Overview tab first.')}
            >
              <Wand2 size={14} className="mr-1" />
              {profileName
                ? t('dataPaths.applyProfileNamed', { profile: profileName, defaultValue: 'Apply the {{profile}} profile' })
                : (t('dataPaths.applyProfile') || 'Apply the profile')}
            </Button>
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus size={14} className="mr-1" />{t('dataPaths.add') || 'Add a path'}
            </Button>
          </>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading') || 'Loading...'}</p>
      ) : error ? (
        <div className="rounded-xl bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">{error}</div>
      ) : paths.length === 0 ? (
        <div className="rounded-xl bg-bg-secondary px-6 py-10 text-center">
          <Database className="mx-auto mb-3 h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-secondary">{t('dataPaths.empty') || 'No data path: the whole site is read only.'}</p>
        </div>
      ) : (
        <TableScroll className="bg-bg-secondary rounded-xl">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr>
                <th className={thCls}>{t('dataPaths.fields.path') || 'Path'}</th>
                <th className={thCls}>{t('dataPaths.fields.policy') || 'Policy'}</th>
                <th className={thCls}>{t('dataPaths.fields.extensions') || 'Allowed extensions'}</th>
                <th className={thCls}>{t('dataPaths.fields.source') || 'Source'}</th>
                <th className={thCls}><span className="sr-only">{t('releases.fields.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {paths.map((p) => (
                <tr key={p.id} className="transition-colors hover:bg-bg-tertiary">
                  <td className={`${tdCls} font-mono text-xs text-text-primary`}>{p.path}/</td>
                  <td className={tdCls}>
                    <PolicyBadge policy={p.policy} />
                    <div className="mt-0.5 max-w-[18rem] text-[11px] text-text-muted">{policyLabel(p.policy).hint}</div>
                  </td>
                  <td className={tdCls}>
                    {p.policy === 'typed' && p.allowedExtensions?.length ? (
                      <div className="flex max-w-[22rem] flex-wrap gap-1">
                        {p.allowedExtensions.slice(0, 14).map((e) => <code key={e} className="rounded bg-bg-tertiary px-1 font-mono text-[10px] text-text-secondary">{e}</code>)}
                        {p.allowedExtensions.length > 14 && <span className="text-[10px] text-text-muted">+{p.allowedExtensions.length - 14}</span>}
                      </div>
                    ) : <span className="text-text-muted">—</span>}
                  </td>
                  <td className={tdCls}>
                    <Pill tone="muted" className="text-[10px]">
                      {p.source === 'profile' ? (t('dataPaths.source.profile') || 'profile') : (t('dataPaths.source.manual') || 'manual')}
                    </Pill>
                  </td>
                  <td className={`${tdCls} whitespace-nowrap text-right`}>
                    {canManage && (
                      <>
                        <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil className="h-3.5 w-3.5" />} size="sm" onClick={() => setEditing(p)} />
                        <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 className="h-3.5 w-3.5" />} variant="danger" size="sm" onClick={() => void remove(p)} />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {editing && (
        <DataPathModal
          siteId={site.id}
          slug={site.slug}
          docroot={site.docroot}
          editing={editing === 'new' ? null : editing}
          existing={paths}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); setChanged(true); await load(); }}
        />
      )}
    </div>
  );
}

function DataPathModal({ siteId, slug, docroot, editing, existing, onClose, onSaved }: {
  siteId: number;
  slug: string;
  /** Normalised document root of the site ('' = release root). */
  docroot: string;
  editing: SiteDataPath | null;
  existing: SiteDataPath[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const policyLabel = usePolicyLabel();
  const [path, setPath] = useState(editing?.path ?? '');
  const [policy, setPolicy] = useState<DataPathPolicy>(editing?.policy ?? 'persistent');
  const [extensions, setExtensions] = useState<string[]>(editing?.allowedExtensions ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const norm = normalizeRelPath(path);
  const overlap = !editing && norm ? findOverlappingPath(norm, existing.map((p) => p.path)) : null;
  // The image refuses a config whose docroot is (inside) a data path.
  const coversDocroot = !editing && !!norm && dataPathContainsDocroot(norm, docroot);
  const docrootMsg = t('dataPaths.containsDocroot', { docroot, defaultValue: 'A data path cannot be or contain the document root ({{docroot}}/): the whole site would become data.' });

  const save = async () => {
    setError('');
    if (!editing && norm === null) { setError(t('dataPaths.pathInvalid') || 'Invalid path: relative, segments of letters, digits and . _ @ + -, without "..".'); return; }
    if (overlap) { setError(t('sites.errors.dataPathOverlap') || 'This path overlaps an existing data path.'); return; }
    if (coversDocroot) { setError(docrootMsg); return; }
    const phpLike = policy === 'typed' ? extensions.filter(isPhpLikeExtension) : [];
    if (phpLike.length > 0) {
      setError(t('dataPaths.extensions.phpRefused', {
        exts: phpLike.map((e) => `.${e}`).join(', '),
        defaultValue: 'Refused: {{exts}}. PHP-like extensions can never be allowed in a data path.',
      }));
      return;
    }
    if (policy === 'typed' && extensions.length === 0) { setError(t('dataPaths.extensions.required') || 'A typed path needs at least one extension.'); return; }
    const allowedExtensions = policy === 'typed' ? extensions : null;
    setSaving(true);
    try {
      if (editing) await sitesApi.updateDataPath(siteId, editing.id, { policy, allowedExtensions });
      else await sitesApi.addDataPath(siteId, { path: norm!, policy, allowedExtensions });
      toast.success(editing ? (t('dataPaths.updated') || 'Data path updated') : (t('dataPaths.added') || 'Data path added'));
      await onSaved();
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const policies: DataPathPolicy[] = ['persistent', 'typed', 'ephemeral'];

  return (
    <Modal
      open
      onClose={() => { if (!saving) onClose(); }}
      size="lg"
      title={editing ? t('dataPaths.editTitle', { path: editing.path, defaultValue: 'Data path {{path}}/' }) : (t('dataPaths.addTitle') || 'New data path')}
      icon={<Database className="h-4 w-4 text-accent" />}
      dismissible={!saving}
      footer={
        <>
          {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" onClick={() => void save()} loading={saving}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={labelCls} htmlFor="dp-path">{t('dataPaths.fields.path') || 'Path'}</label>
          <input
            id="dp-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            disabled={!!editing}
            placeholder="wp-content/uploads"
            className={`${fieldCls} font-mono ${path && norm === null ? 'ring-2 ring-red-400/60' : ''}`}
            autoFocus={!editing}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="mt-1 break-all font-mono text-[11px] text-text-muted">
            {norm ? `→ /data/${slug}/${norm}/` : (t('dataPaths.pathHint') || 'Relative to the root of the release (not to the document root).')}
          </p>
          {overlap && <p className="mt-1 text-xs text-red-400">{t('dataPaths.overlapWith', { path: overlap, defaultValue: 'Overlaps {{path}}/' })}</p>}
          {coversDocroot && <p className="mt-1 text-xs text-red-400">{docrootMsg}</p>}
          {editing && <p className="mt-1 text-xs text-text-muted">{t('dataPaths.pathImmutable') || 'The path cannot be changed: delete and add it again.'}</p>}
        </div>

        <div>
          <div className={sectionLabelCls}>{t('dataPaths.fields.policy') || 'Policy'}</div>
          <SegmentedTabs<DataPathPolicy>
            size="sm"
            value={policy}
            onChange={setPolicy}
            ariaLabel={t('dataPaths.fields.policy') || 'Policy'}
            tabs={policies.map((p) => ({ id: p, label: policyLabel(p).label }))}
          />
          <p className="mt-2 text-xs text-text-muted">{policyLabel(policy).hint}</p>
        </div>

        {policy === 'typed' && (
          <div>
            <div className={sectionLabelCls}>{t('dataPaths.fields.extensions') || 'Allowed extensions'}</div>
            <ExtensionChips value={extensions} onChange={setExtensions} />
          </div>
        )}
      </div>
    </Modal>
  );
}
