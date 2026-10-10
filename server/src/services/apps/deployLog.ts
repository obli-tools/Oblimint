// ─────────────────────────────────────────────────────────────────────────────
// Output of a deployment (docs/P4b-PLAN.md §5.1, AP4): every line is redacted
// (values of the stack .env, registry passwords, git token) BEFORE it is kept
// or emitted, the log is capped at 2000 lines / 256 KiB (oldest lines dropped,
// a marker kept), and new lines are flushed to the listeners in batches.
// Error lines follow the status-message convention "<French label> : <raw
// cause>": a client only gets the label (statusMessage.clientStatusMessage).
// ─────────────────────────────────────────────────────────────────────────────

export const LOG_MAX_LINES = 2000;
export const LOG_MAX_BYTES = 256 * 1024;
const LINE_MAX = 2000;

export class DeployLog {
  readonly lines: string[] = [];
  private bytes = 0;
  private dropped = 0;
  private pending: string[] = [];
  private secrets: string[] = [];

  constructor(private readonly onLines: ((lines: string[]) => void) | null = null) {}

  /** Values that must never appear in the log (≥ 4 chars, longest first so substrings never leak). */
  addSecrets(values: Iterable<string>): void {
    for (const v of values) if (v && v.length >= 4 && !this.secrets.includes(v)) this.secrets.push(v);
    this.secrets.sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) if (out.includes(s)) out = out.split(s).join('***');
    return out;
  }

  add(text: string): void {
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      if (!raw.trim()) continue;
      const line = this.redact(raw).slice(0, LINE_MAX);
      this.lines.push(line);
      this.pending.push(line);
      this.bytes += Buffer.byteLength(line, 'utf8') + 1;
    }
    while (this.lines.length > LOG_MAX_LINES || this.bytes > LOG_MAX_BYTES) {
      const first = this.lines.shift();
      if (first === undefined) break;
      this.bytes -= Buffer.byteLength(first, 'utf8') + 1;
      this.dropped++;
    }
  }

  /** Lines added since the last flush (for the live output). */
  flush(): void {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    try { this.onLines?.(batch); } catch { /* listeners never break a deployment */ }
  }

  /** What is persisted (with a marker when old lines were dropped). */
  snapshot(): string[] {
    return this.dropped ? [`… ${this.dropped} ligne(s) plus anciennes omises`, ...this.lines] : [...this.lines];
  }
}
