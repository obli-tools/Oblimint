import { MailDnsLookupError, type MailDnsLookup, type MailMx, type MailSrv } from './lookup';

// Tests only: in-memory MailDnsLookup (checks.test.ts, mailDnsTls.db.test.ts).

/** In-memory resolver: tables per type; `fail` names throw a resolver error. */
export function fakeLookup(data: {
  mx?: Record<string, MailMx[]>; txt?: Record<string, string[]>; a?: Record<string, string[]>; aaaa?: Record<string, string[]>;
  srv?: Record<string, MailSrv[]>; ptr?: Record<string, string[]>; fail?: string[];
}): MailDnsLookup & { calls: string[] } {
  const calls: string[] = [];
  const get = <T>(kind: string, table: Record<string, T[]> | undefined, name: string): Promise<T[]> => {
    calls.push(`${kind} ${name}`);
    if (data.fail?.includes(name)) return Promise.reject(new MailDnsLookupError(`${kind} ${name}: ETIMEOUT`, 'ETIMEOUT'));
    return Promise.resolve(table?.[name] ?? []);
  };
  return {
    calls,
    mx: (n) => get('MX', data.mx, n), txt: (n) => get('TXT', data.txt, n), a: (n) => get('A', data.a, n),
    aaaa: (n) => get('AAAA', data.aaaa, n), srv: (n) => get('SRV', data.srv, n), ptr: (n) => get('PTR', data.ptr, n),
  };
}
