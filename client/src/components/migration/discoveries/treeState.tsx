import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { TreeNode } from '../migrationUi';

// Open / closed state of the inventory tree: per-node overrides on top of a
// global mode (expand all / collapse all / defaults). OWNED BY MODULE `ui-migration`.

type Mode = 'default' | 'all' | 'none';

interface TreeState {
  isOpen: (id: string, defaultOpen: boolean) => boolean;
  set: (id: string, open: boolean) => void;
}

const Ctx = createContext<TreeState>({ isOpen: (_id, d) => d, set: () => undefined });

export function useTreeController(forceOpen: boolean) {
  const [mode, setMode] = useState<Mode>('default');
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const value = useMemo<TreeState>(() => ({
    isOpen: (id, d) => overrides.get(id) ?? (forceOpen || mode === 'all' ? true : mode === 'none' ? false : d),
    set: (id, open) => setOverrides((cur) => new Map(cur).set(id, open)),
  }), [mode, overrides, forceOpen]);
  const expandAll = useCallback(() => { setMode('all'); setOverrides(new Map()); }, []);
  const collapseAll = useCallback(() => { setMode('none'); setOverrides(new Map()); }, []);
  return { value, expandAll, collapseAll };
}

export function TreeProvider({ value, children }: { value: TreeState; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** TreeNode bound to the shared open state (id must be unique in the tree). */
export function Node({ id, defaultOpen = false, ...rest }: {
  id: string;
  defaultOpen?: boolean;
  title: ReactNode;
  meta?: ReactNode;
  badges?: ReactNode;
  children?: ReactNode;
  level?: number;
}) {
  const ctx = useContext(Ctx);
  return <TreeNode {...rest} open={ctx.isOpen(id, defaultOpen)} onToggle={(o) => ctx.set(id, o)} />;
}
