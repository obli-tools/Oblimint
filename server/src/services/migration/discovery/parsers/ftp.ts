import type { CwpFtpUser } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// ftp.listUsers (docs/P5-PLAN.md §5.4 bis): `login:uid:gid:dir:scheme` per
// Pure-FTPd virtual user (the hash field is never printed). The directory keeps
// the chroot marker `/./` (`/home/acct1/public_html/./` → chroot at that dir).
// ─────────────────────────────────────────────────────────────────────────────

export interface FtpListLine {
  login: string;
  uid: number | null;
  gid: number | null;
  directory: string;
  chroot: boolean;
  hashScheme: CwpFtpUser['hashScheme'];
}

export function ftpScheme(s: string): CwpFtpUser['hashScheme'] {
  switch (s.trim()) {
    case '2a': case '2b': case '2y': return 'bcrypt';
    case '6': return 'sha512-crypt';
    case '1': return 'md5-crypt';
    default: return 'other';
  }
}

export function parseFtpListUsers(text: string): FtpListLine[] {
  const out: FtpListLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    const f = l.split(':');
    if (f.length < 5 || !f[0]) continue;
    const scheme = f[f.length - 1];
    let dir = f.slice(3, f.length - 1).join(':');
    const chroot = dir.includes('/./');
    if (chroot) dir = dir.slice(0, dir.indexOf('/./'));
    dir = dir.replace(/\/+$/, '') || '/';
    const uid = /^\d+$/.test(f[1]) ? Number(f[1]) : null;
    const gid = /^\d+$/.test(f[2]) ? Number(f[2]) : null;
    out.push({ login: f[0], uid, gid, directory: dir, chroot, hashScheme: ftpScheme(scheme) });
  }
  return out;
}
