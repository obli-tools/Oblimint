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

export class CsvReader {
  private buf = '';
  private line = 1;
  private first = true;
  private readonly d: string;
  private readonly maxField: number;

  constructor(opts: { delimiter: string; maxField?: number }) {
    if (opts.delimiter.length !== 1 || opts.delimiter === '"' || opts.delimiter === '\n' || opts.delimiter === '\r') {
      throw new AppError(400, 'Invalid CSV delimiter', 'validation', { field: 'csvDelimiter' });
    }
    this.d = opts.delimiter;
    this.maxField = opts.maxField ?? 16 * 1024 * 1024;
  }

  push(text: string): CsvRecord[] {
    if (this.first) {
      if (!text.length) return [];
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.first = false;
    }
    this.buf += text;
    return this.parse(false);
  }

  end(): CsvRecord[] {
    return this.parse(true);
  }

  /** Parses whole records from buf; keeps an incomplete one (re-read later: records are short next to a chunk). */
  private parse(final: boolean): CsvRecord[] {
    const out: CsvRecord[] = [];
    const buf = this.buf;
    const n = buf.length;
    let pos = 0;
    while (pos < n) {
      const startLine = this.line;
      let lines = 0;
      const fields: string[] = [];
      let i = pos;
      let complete = false;
      for (;;) {
        // One field.
        if (buf[i] === '"') {
          let v = '';
          let k = i + 1;
          let closed = false;
          while (k < n) {
            const q = buf.indexOf('"', k);
            if (q < 0) { v += buf.slice(k); k = n; break; }
            v += buf.slice(k, q);
            if (buf[q + 1] === '"') { v += '"'; k = q + 2; continue; }
            if (q + 1 >= n && !final) { k = n; break; }
            k = q + 1;
            closed = true;
            break;
          }
          if (!closed) {
            if (!final) break;
            throw new AppError(400, `CSV: unterminated quoted field (line ${startLine})`, 'csvError');
          }
          for (const ch of v) if (ch === '\n') lines++;
          if (v.length > this.maxField) throw new AppError(413, `CSV: field too long (line ${startLine})`, 'csvError');
          fields.push(v);
          i = k;
          const c = buf[i];
          if (c === this.d) { i++; continue; }
          if (c === '\r' && buf[i + 1] === '\n') { i += 2; lines++; complete = true; break; }
          if (c === '\r' && i + 1 >= n && !final) break;
          if (c === '\n' || c === '\r') { i++; lines++; complete = true; break; }
          if (c === undefined) { if (final) { complete = true; } break; }
          throw new AppError(400, `CSV: unexpected character after a quoted field (line ${startLine + lines})`, 'csvError');
        }
        // Unquoted field: up to the delimiter or the end of the line.
        let k = i;
        while (k < n && buf[k] !== this.d && buf[k] !== '\n' && buf[k] !== '\r') k++;
        if (k - i > this.maxField) throw new AppError(413, `CSV: field too long (line ${startLine})`, 'csvError');
        if (k >= n) {
          if (!final) break;
          fields.push(buf.slice(i, k));
          i = k;
          complete = true;
          break;
        }
        fields.push(buf.slice(i, k));
        const c = buf[k];
        if (c === this.d) { i = k + 1; if (i >= n && final) { fields.push(''); complete = true; break; } continue; }
        if (c === '\r') {
          if (k + 1 >= n && !final) break;
          i = buf[k + 1] === '\n' ? k + 2 : k + 1;
        } else i = k + 1;
        lines++;
        complete = true;
        break;
      }
      if (!complete) break;
      pos = i;
      this.line = startLine + lines;
      // A blank line is no record.
      if (!(fields.length === 1 && fields[0] === '')) out.push({ fields, line: startLine });
    }
    this.buf = buf.slice(pos);
    if (this.buf.length > this.maxField * 4) throw new AppError(413, `CSV: record too long (line ${this.line})`, 'csvError');
    return out;
  }
}
