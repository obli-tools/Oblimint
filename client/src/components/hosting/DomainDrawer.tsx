import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import type { Domain } from '@oblimint/shared';
import { Drawer } from '@/components/common/Drawer';
import { withDomainDrawer } from '@/utils/links';
import { DomainPanel } from './DomainPanel';

// The domain drawer (coherence plan 1.4) opens on ANY page from ?domain=<id>:
// the site's Domains tab, the account, the mail domain, a migration plan…
// One instance, mounted by the layout. The lists showing domains follow its
// changes through a window event (no prop drilling across pages).

const EVENT = 'oblimint:domain-drawer';

export type DomainDrawerEvent = { type: 'changed'; domain: Domain } | { type: 'deleted'; id: number };

/** Rows of a domain list follow what the drawer changed / deleted. */
export function useDomainDrawerEvents(handler: (e: DomainDrawerEvent) => void): void {
  useEffect(() => {
    const listener = (ev: Event) => handler((ev as CustomEvent<DomainDrawerEvent>).detail);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [handler]);
}

/** Open / close the drawer of a domain on the current page (?domain=). */
export function useDomainDrawer(): { domainId: number | null; open: (id: number) => void; close: () => void } {
  const [params, setParams] = useSearchParams();
  const domainId = Number(params.get('domain')) || null;
  return {
    domainId,
    open: (id) => setParams((prev) => withDomainDrawer(prev, id)),
    close: () => setParams((prev) => withDomainDrawer(prev, null), { replace: true }),
  };
}

export function GlobalDomainDrawer() {
  const { t } = useTranslation();
  const { domainId, close } = useDomainDrawer();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => { setName(null); }, [domainId]);

  const emit = (detail: DomainDrawerEvent) => window.dispatchEvent(new CustomEvent<DomainDrawerEvent>(EVENT, { detail }));

  return (
    <Drawer
      open={domainId != null}
      onClose={close}
      side="right"
      size="lg"
      title={name ?? (t('domains.detailTitle') || 'Domain')}
      icon={<Globe size={16} className="shrink-0 text-accent" />}
      bodyClassName="p-4"
    >
      {domainId != null && (
        <DomainPanel
          key={domainId}
          domainId={domainId}
          onChanged={(d) => { setName(d.name); emit({ type: 'changed', domain: d }); }}
          onDeleted={() => { emit({ type: 'deleted', id: domainId }); close(); }}
        />
      )}
    </Drawer>
  );
}
