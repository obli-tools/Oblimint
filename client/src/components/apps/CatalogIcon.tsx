import { useState } from 'react';
import {
  Activity, BarChart3, Bell, BookOpen, Bot, Boxes, Calendar, Cloud, Code2, Database, FileText, Film, Gauge, GitBranch, Globe, HardDrive,
  Image, KeyRound, LayoutGrid, Lock, Mail, MessageSquare, Music, Package, Search, Server, Shield, Workflow, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/utils/cn';

/** Lucide icons a template may name (kebab or Pascal case); anything else → Boxes. */
const ICONS: Record<string, LucideIcon> = {
  activity: Activity, 'bar-chart-3': BarChart3, barchart3: BarChart3, bell: Bell, 'book-open': BookOpen, bookopen: BookOpen, bot: Bot,
  boxes: Boxes, calendar: Calendar, cloud: Cloud, 'code-2': Code2, code2: Code2, database: Database, 'file-text': FileText, filetext: FileText,
  film: Film, gauge: Gauge, 'git-branch': GitBranch, gitbranch: GitBranch, globe: Globe, 'hard-drive': HardDrive, harddrive: HardDrive,
  image: Image, 'key-round': KeyRound, keyround: KeyRound, 'layout-grid': LayoutGrid, layoutgrid: LayoutGrid, lock: Lock, mail: Mail,
  'message-square': MessageSquare, messagesquare: MessageSquare, music: Music, package: Package, search: Search, server: Server,
  shield: Shield, workflow: Workflow,
};

/**
 * Icon of a catalog template: a lucide name, or a same-origin URL
 * (/api/apps/catalog/:slug/icon). External URLs are not loaded (no third-party
 * request from the panel).
 */
export function CatalogIcon({ icon, size = 32, className }: { icon: string | null | undefined; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const box = cn('flex shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-accent', className);
  if (icon && icon.startsWith('/') && !icon.startsWith('//') && !broken) {
    return (
      <span className={box} style={{ width: size, height: size }}>
        <img src={icon} alt="" width={size - 8} height={size - 8} className="object-contain" onError={() => setBroken(true)} />
      </span>
    );
  }
  const key = (icon ?? '').trim().toLowerCase();
  const Icon = ICONS[key] ?? ICONS[key.replace(/-/g, '')] ?? Boxes;
  return (
    <span className={box} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.5)} />
    </span>
  );
}
