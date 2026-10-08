import { readFileSync } from 'fs';
import path from 'path';

function readVersion(file: string): string | null {
  try {
    return (JSON.parse(readFileSync(file, 'utf-8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

// server/src (tsx) or server/dist/src (compiled): server/package.json is
// two or three levels up; the client's package.json sits next to server/.
const serverRoots = [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../..')];

export const serverVersion: string =
  serverRoots.map((r) => readVersion(path.join(r, 'package.json'))).find((v): v is string => !!v && v !== undefined) ?? 'dev';

export function clientVersion(): string {
  for (const r of serverRoots) {
    const v = readVersion(path.join(r, '..', 'client', 'package.json'));
    if (v) return v;
  }
  return 'unknown';
}
