import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/** Empty / error state of a list or a tab: icon + text + optional action (coherence plan C8). */
export function EmptyState({ icon, text, action, className }: {
  icon: ReactNode;
  text: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-xl bg-bg-secondary px-4 py-12 text-center text-text-muted', className)}>
      <div className="opacity-40 [&>svg]:h-6 [&>svg]:w-6">{icon}</div>
      <div className="text-sm">{text}</div>
      {action}
    </div>
  );
}
