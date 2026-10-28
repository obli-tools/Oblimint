import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

// The one status / mode chip of the panel (coherence plan C7) — the Obliance
// badge (DeviceStatusBadge, scheduledTaskFormat Badge): rounded-full, tinted
// background, thin border, text-xs. Colour rule: `red` = an error, `muted` =
// offline / neutral (never red for a state that is merely off).

const pillCls = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium';

export const TONES = {
  green: 'border-status-up/30 bg-status-up/10 text-status-up',
  blue: 'border-blue-400/30 bg-blue-500/10 text-blue-400',
  amber: 'border-amber-400/30 bg-amber-400/10 text-amber-400',
  red: 'border-red-400/30 bg-red-500/10 text-red-400',
  orange: 'border-orange-400/30 bg-orange-400/10 text-orange-400',
  muted: 'border-border bg-bg-tertiary text-text-muted',
  accent: 'border-accent/30 bg-accent/10 text-accent',
} as const;
export type Tone = keyof typeof TONES;

export function Pill({ tone = 'muted', children, className, title }: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return <span className={cn(pillCls, TONES[tone], className)} title={title}>{children}</span>;
}
