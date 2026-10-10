import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppRegistryCredential } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { labelCls } from '@/components/hosting/hostingUi';

/** Registry credentials of an account used by a stack (multi-select). Hidden when the account has none. */
export function RegistryPicker({ accountId, value, onChange }: {
  accountId: number | null;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AppRegistryCredential[]>([]);
  useEffect(() => {
    if (accountId == null) { setItems([]); return; }
    let cancelled = false;
    appsApi.listRegistries({ accountId })
      .then((l) => { if (!cancelled) setItems(l); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [accountId]);
  if (items.length === 0) return null;
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div>
      <div className={labelCls}>{t('apps.registries.useTitle') || 'Registry credentials used to pull the images'}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {items.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary coarse:min-h-10">
            <input type="checkbox" checked={value.includes(r.id)} onChange={() => toggle(r.id)} className="accent-accent" />
            <span className="font-mono text-[13px]">{r.username} @ {r.registry}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
