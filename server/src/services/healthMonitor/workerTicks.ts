// Last "tick" of the background workers, for the deep health check: the
// reconcile worker records one when it starts and at each periodic full pass
// whose account list was read (event loop alive, timers firing, database
// answering). In memory: a restart starts over (with a fresh start tick).

const ticks = new Map<string, number>();

export function recordWorkerTick(name: string, at: number = Date.now()): void {
  ticks.set(name, at);
}

export function lastWorkerTick(name: string): number | null {
  return ticks.get(name) ?? null;
}

/** Tests. */
export function resetWorkerTicksForTests(): void {
  ticks.clear();
}
