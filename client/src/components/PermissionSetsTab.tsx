import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Check, Shield, Pencil, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { PermissionSet } from '@oblimint/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { TableScroll } from '@/components/common/TableScroll';
import { Tip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { MEDIA, useIsCoarsePointer, useMediaQuery } from '@/hooks/useMediaQuery';
import { permissionSetsApi } from '@/api/permissionSets.api';
import { apiErrorMessage } from '@/api/client';
import type { CapabilityDef } from '@/types';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Permission sets × capabilities matrix — ported from Obliance. */
export function PermissionSetsTab() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  // Narrow screens: the Capability column stays pinned while the matrix
  // scrolls; touch: bigger cells + explicit ✓ / ✕ on the rename field.
  const isWide = useMediaQuery(MEDIA.lg);
  const coarse = useIsCoarsePointer();

  const [sets, setSets] = useState<PermissionSet[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityDef[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Rename inline
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const capLabel = (cap: CapabilityDef) => t(`capabilities.${cap.key}`, { defaultValue: cap.label || cap.key });

  const fetchData = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([permissionSetsApi.list(), permissionSetsApi.capabilities()]);
      setSets(s);
      setCapabilities(c);
    } catch {
      toast.error(t('permissionSets.loadFailed') || 'Failed to load permission sets');
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleCapability = async (set: PermissionSet, capKey: string) => {
    const has = set.capabilities.includes(capKey);
    const updated = has
      ? set.capabilities.filter((c) => c !== capKey)
      : [...set.capabilities, capKey];

    // Optimistic update
    setSets((prev) =>
      prev.map((s) => (s.id === set.id ? { ...s, capabilities: updated } : s)),
    );

    try {
      await permissionSetsApi.update(set.id, { capabilities: updated });
    } catch {
      toast.error(t('permissionSets.updateFailed') || 'Failed to update permission set');
      fetchData(); // revert
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await permissionSetsApi.create({
        name: newName.trim(),
        slug: slugify(newName.trim()),
        capabilities: [],
      });
      toast.success(t('permissionSets.created') || 'Permission set created');
      setNewName('');
      setShowCreate(false);
      fetchData();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('permissionSets.createFailed') || 'Failed to create permission set'));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (set: PermissionSet) => {
    if (!(await confirm({
      message: t('permissionSets.confirmDelete', { defaultValue: 'Delete permission set "{{name}}"? This cannot be undone.', name: set.name }),
      danger: true,
    }))) return;
    try {
      await permissionSetsApi.delete(set.id);
      toast.success(t('permissionSets.deleted') || 'Permission set deleted');
      fetchData();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('permissionSets.deleteFailed') || 'Failed to delete permission set'));
    }
  };

  const handleRename = async (set: PermissionSet) => {
    if (!renameValue.trim() || renameValue.trim() === set.name) {
      setRenamingId(null);
      return;
    }
    try {
      await permissionSetsApi.update(set.id, { name: renameValue.trim() });
      toast.success(t('permissionSets.renamed') || 'Permission set renamed');
      setRenamingId(null);
      fetchData();
    } catch {
      toast.error(t('permissionSets.renameFailed') || 'Failed to rename permission set');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-muted text-sm">
        {t('permissionSets.loading') || 'Loading permission sets...'}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-text-primary">
          {t('users.permissionSets') || 'Permission sets'}
        </h2>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus size={14} className="mr-1" />
          {t('common.new') || 'New'}
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mb-4 rounded-lg bg-bg-secondary p-4">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            {t('permissionSets.newTitle') || 'New permission set'}
          </h3>
          <div className="flex items-center gap-2">
            <div className="min-w-0 max-sm:flex-1">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('permissionSets.namePlaceholder') || 'Set name (e.g. Support L1)'}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                enterKeyHint="done"
                autoFocus
              />
            </div>
            <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()} loading={creating} className="shrink-0">
              {t('common.create') || 'Create'}
            </Button>
            <IconButton
              label={t('common.cancel') || 'Cancel'}
              icon={<X size={16} />}
              size="sm"
              variant="plain"
              onClick={() => { setShowCreate(false); setNewName(''); }}
              className="shrink-0"
            />
          </div>
        </div>
      )}

      {/* Matrix table */}
      {capabilities.length === 0 ? (
        <div className="text-sm text-text-muted py-8 text-center">
          {t('permissionSets.noCapabilities') || 'No capabilities defined.'}
        </div>
      ) : (
        <TableScroll className="rounded-lg" stickyFirstCol={!isWide} stickyBg="rgb(var(--c-bg-secondary))">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-secondary">
                <th className="text-left px-3 py-2.5 text-text-secondary font-medium whitespace-nowrap">
                  {t('permissionSets.capability') || 'Capability'}
                </th>
                {sets.map((set) => (
                  <th key={set.id} className="px-3 py-2.5 text-center min-w-[100px]">
                    <div className="flex items-center justify-center gap-1">
                      {renamingId === set.id ? (
                        <>
                          <input
                            className="bg-bg-tertiary rounded px-1.5 py-0.5 coarse:py-1.5 text-xs text-text-primary w-20 text-center"
                            value={renameValue}
                            aria-label={t('permissionSets.rename') || 'Rename'}
                            onChange={(e) => setRenameValue(e.target.value)}
                            // Touch: explicit ✓ / ✕ below — blur must not commit before the ✕ tap lands.
                            onBlur={coarse ? undefined : () => handleRename(set)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRename(set);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            enterKeyHint="done"
                            autoFocus
                          />
                          {coarse && (
                            <>
                              <IconButton
                                label={t('common.save') || 'Save'}
                                icon={<Check size={14} />}
                                size="sm"
                                variant="accent"
                                onClick={() => handleRename(set)}
                              />
                              <IconButton
                                label={t('common.cancel') || 'Cancel'}
                                icon={<X size={14} />}
                                size="sm"
                                variant="plain"
                                onClick={() => setRenamingId(null)}
                              />
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="text-text-primary font-medium text-xs">
                            {set.name}
                          </span>
                          {set.isDefault && (
                            <Tip content={t('permissionSets.defaultSet') || 'Default set'}>
                              <Shield size={11} className="text-accent shrink-0" />
                            </Tip>
                          )}
                        </>
                      )}
                    </div>
                    {renamingId !== set.id && (
                      <div className="flex items-center justify-center gap-0.5 coarse:gap-2 mt-1">
                        <IconButton
                          label={t('permissionSets.rename') || 'Rename'}
                          icon={<Pencil size={10} />}
                          size="xs"
                          variant="plain"
                          onClick={() => { setRenamingId(set.id); setRenameValue(set.name); }}
                          className="opacity-60 hover:opacity-100 coarse:opacity-100"
                        />
                        {!set.isDefault && (
                          <IconButton
                            label={t('common.delete') || 'Delete'}
                            icon={<Trash2 size={10} />}
                            size="xs"
                            variant="plain"
                            onClick={() => handleDelete(set)}
                            className="opacity-60 hover:opacity-100 coarse:opacity-100 hover:text-status-down"
                          />
                        )}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capabilities.map((cap, idx) => (
                <tr
                  key={cap.key}
                  className={`last:border-b-0 ${
                    idx % 2 === 0 ? 'bg-bg-primary [--table-sticky-bg:rgb(var(--c-bg-primary))]' : 'bg-bg-secondary/50 [--table-sticky-bg:rgb(var(--c-bg-secondary))]'
                  } hover:bg-bg-hover hover:[--table-sticky-bg:rgb(var(--c-bg-hover))] transition-colors`}
                >
                  <td className="px-3 py-2 text-text-primary whitespace-nowrap font-medium text-xs">
                    {capLabel(cap)}
                  </td>
                  {sets.map((set) => {
                    const checked = set.capabilities.includes(cap.key);
                    return (
                      <td key={set.id} className="px-3 py-2 text-center">
                        <button
                          onClick={() => toggleCapability(set, cap.key)}
                          aria-pressed={checked}
                          aria-label={`${capLabel(cap)} — ${set.name}`}
                          // Touch: 20px box inside an invisible 40px hit area.
                          className={`relative w-5 h-5 rounded border inline-flex items-center justify-center transition-colors coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-[''] ${
                            checked
                              ? 'bg-accent border-accent text-white'
                              : 'border-transparent bg-bg-tertiary hover:border-text-muted'
                          }`}
                        >
                          {checked && <Check size={12} strokeWidth={3} />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {sets.length === 0 && capabilities.length > 0 && (
        <div className="text-sm text-text-muted py-8 text-center">
          {t('permissionSets.empty') || 'No permission sets defined. Click "New" to create one.'}
        </div>
      )}
    </div>
  );
}
