import fs from 'fs';
import os from 'os';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// TEST helper of module executor-mail-dns: the DB suites of the module
// (dkimImport, cutover, mail-dns provider) share ONE PGlite server (port 55485)
// and each recreates the public schema; `node --test` runs files in parallel
// processes. A directory lock in the OS temp dir (mkdir is atomic) serializes
// them; a lock left by a dead process (pid gone) or older than 10 min is broken.
// ─────────────────────────────────────────────────────────────────────────────

const STALE_MS = 10 * 60_000;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Waits for the lock named `name`; returns the release function. */
export async function acquireDbTestLock(name: string, timeoutMs = 280_000): Promise<() => void> {
  const dir = path.join(os.tmpdir(), `oblimint-dbtest-${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(dir, { recursive: true, force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
        const age = Date.now() - fs.statSync(dir).mtimeMs;
        if ((pid && !alive(pid)) || age > STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* being created / removed by its owner */ }
      if (Date.now() > deadline) throw new Error(`DB test lock ${name} not acquired in time`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
