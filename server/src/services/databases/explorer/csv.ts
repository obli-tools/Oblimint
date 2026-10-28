import type { DbxCell } from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// CSV of the database explorer (RFC 4180): a writer for exports (fields with
// the delimiter, a quote or a line break are quoted, quotes doubled; NULL is
// an empty field) and an incremental reader for imports (quoted fields may
// hold delimiters, doubled quotes and line breaks; \r\n or \n; a UTF-8 BOM is
// dropped). Records come out with the line they start on.
// ─────────────────────────────────────────────────────────────────────────────

/** Export text of a cell (binary: 0x + hex of what was read; JSON-like values as text). */
export function exportCellText(c: unknown): string {
  if (c === null || c === undefined) return '';
  if (Buffer.isBuffer(c)) return `0x${c.toString('hex')}`;
  if (typeof c === 'object') {
    const o = c as { binary?: true; hex?: string; long?: true; text?: string };
    if (o.binary) return `0x${o.hex ?? ''}`;
    if (o.long) return o.text ?? '';
    return JSON.stringify(c);
  }
  return String(c);
}

export function csvField(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || value.includes('\n') || value.includes('\r')) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvLine(values: Array<string | null>, delimiter: string): string {
  return `${values.map((v) => (v === null ? '' : csvField(v, delimiter))).join(delimiter)}\r\n`;
}

/** JSON value of an exported cell (numbers kept, binary as 0x…). */
export function jsonCell(c: DbxCell | Buffer | unknown): unknown {
  if (c === null || c === undefined) return null;
  if (Buffer.isBuffer(c)) return `0x${c.toString('hex')}`;
  if (typeof c === 'object') {
    const o = c as { binary?: true; hex?: string; long?: true; text?: string };
    if (o.binary) return `0x${o.hex ?? ''}`;
    if (o.long) return o.text ?? '';
  }
  return c;
}

export interface CsvRecord {
  fields: string[];
  /** Line the record starts on (1-based). */
  line: number;
}

/** Reader states: start of a field, in an unquoted field, inside quotes, a quote seen inside quotes, after a \r ending a record. */
const Cs = { Field: 0, Unquoted: 1, Quoted: 2, QuoteInQuoted: 3, AfterCr: 4 } as const;

/**
 * Incremental reader: a state machine fed chunk by chunk, every character read
 * once (a record split over chunks is never parsed again), a field kept as
 * pieces joined at its end. Caps: a field (maxField), a record (4 × maxField).
 */
/** Fields of one record (MySQL: 4096 columns at most, PostgreSQL: 1600). */
export const CSV_MAX_FIELDS = 10_000;

export class CsvReader {
  private line = 1;
  private recLine = 1;
  private first = true;
  private st: number = Cs.Field;
  private fields: string[] = [];
  private piece: string[] = [];
  private fieldLen = 0;
  private recLen = 0;
  private readonly d: string;
  private readonly maxField: number;
  /** Sticky run of an unquoted field (up to the delimiter or a line break). */
  private readonly unquoted: RegExp;

  constructor(opts: { delimiter: string; maxField?: number }) {
    if (opts.delimiter.length !== 1 || opts.delimiter === '"' || opts.delimiter === '\n' || opts.delimiter === '\r') {
      throw new AppError(400, 'Invalid CSV delimiter', 'validation', { field: 'csvDelimiter' });
    }
    this.d = opts.delimiter;
    this.maxField = opts.maxField ?? 16 * 1024 * 1024;
    this.unquoted = new RegExp(`[^${opts.delimiter.replace(/[\\\]^-]/g, '\\$&')}\\r\\n]*`, 'y');
  }

  push(text: string): CsvRecord[] {
    if (this.first) {
      if (!text.length) return [];
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.first = false;
    }
    return this.parse(text, false);
  }

  end(): CsvRecord[] {
    return this.parse('', true);
  }

  private add(s: string): void {
    if (!s) return;
    this.piece.push(s);
    this.fieldLen += s.length;
    this.recLen += s.length;
    if (this.fieldLen > this.maxField) throw new AppError(413, `CSV: field too long (line ${this.recLine})`, 'csvError');
    if (this.recLen > this.maxField * 4) throw new AppError(413, `CSV: record too long (line ${this.recLine})`, 'csvError');
  }

  private endField(): void {
    if (this.fields.length >= CSV_MAX_FIELDS) throw new AppError(413, `CSV: more than ${CSV_MAX_FIELDS} fields (line ${this.recLine})`, 'csvError');
    this.fields.push(this.piece.length === 1 ? this.piece[0] : this.piece.join(''));
    this.piece = [];
    this.fieldLen = 0;
  }

  private endRecord(out: CsvRecord[]): void {
    this.endField();
    const f = this.fields;
    this.fields = [];
    this.recLen = 0;
    // A blank line is no record.
    if (!(f.length === 1 && f[0] === '')) out.push({ fields: f, line: this.recLine });
  }

  private parse(s: string, final: boolean): CsvRecord[] {
    const out: CsvRecord[] = [];
    const n = s.length;
    let i = 0;
    while (i < n) {
      switch (this.st) {
        case Cs.AfterCr:
          this.st = Cs.Field;
          if (s[i] === '\n') i++; // \r\n: one line break, already counted
          continue;
        case Cs.Field:
          if (!this.fields.length) this.recLine = this.line;
          if (s[i] === '"') { this.st = Cs.Quoted; i++; } else this.st = Cs.Unquoted;
          continue;
        case Cs.Unquoted: {
          this.unquoted.lastIndex = i;
          this.unquoted.exec(s);
          const k = this.unquoted.lastIndex;
          this.add(s.slice(i, k));
          i = k;
          if (i >= n) continue;
          const c = s[i++];
          if (c === this.d) { this.endField(); this.st = Cs.Field; continue; }
          this.line++;
          this.endRecord(out);
          this.st = c === '\r' ? Cs.AfterCr : Cs.Field;
          continue;
        }
        case Cs.Quoted: {
          const q = s.indexOf('"', i);
          const end = q < 0 ? n : q;
          for (let k = s.indexOf('\n', i); k >= 0 && k < end; k = s.indexOf('\n', k + 1)) this.line++;
          this.add(s.slice(i, end));
          i = q < 0 ? n : q + 1;
          if (q >= 0) this.st = Cs.QuoteInQuoted;
          continue;
        }
        case Cs.QuoteInQuoted: {
          const c = s[i++];
          if (c === '"') { this.add('"'); this.st = Cs.Quoted; continue; }
          if (c === this.d) { this.endField(); this.st = Cs.Field; continue; }
          if (c === '\n' || c === '\r') {
            this.line++;
            this.endRecord(out);
            this.st = c === '\r' ? Cs.AfterCr : Cs.Field;
            continue;
          }
          throw new AppError(400, `CSV: unexpected character after a quoted field (line ${this.line})`, 'csvError');
        }
        default:
          i = n;
      }
    }
    if (final) {
      if (this.st === Cs.Quoted) throw new AppError(400, `CSV: unterminated quoted field (line ${this.recLine})`, 'csvError');
      if (this.st === Cs.Unquoted || this.st === Cs.QuoteInQuoted || (this.st === Cs.Field && this.fields.length)) this.endRecord(out);
      this.st = Cs.Field;
    }
    return out;
  }
}
