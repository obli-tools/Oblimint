// Environment variables of a site: given to its containers (PHP getenv() /
// $_SERVER, cron jobs, CLI). The way to keep secrets (API keys, passwords)
// out of the code and out of the public docroot. A change restarts the site.

export interface SiteEnvVar {
  name: string;
  /** null for a secret: the value is never sent back (write-only). */
  value: string | null;
  secret: boolean;
  updatedAt: string;
}

export interface SiteEnvVarInput {
  name: string;
  /** Omitted / null on an existing secret: the stored value is kept. */
  value?: string | null;
  secret?: boolean;
}

export const SITE_ENV_MAX_VARS = 200;
export const SITE_ENV_MAX_VALUE = 32 * 1024;
export const SITE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Names the platform keeps for itself (process environment, PHP / web server start-up). */
export function reservedEnvName(name: string): boolean {
  const n = name.toUpperCase();
  return ['PATH', 'HOME', 'HOSTNAME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'IFS', 'PHPRC', 'GCONV_PATH', 'HOSTALIASES', 'NLSPATH', 'PGHOST'].includes(n)
    || /^(OBLIMINT_|LD_|PHP_INI|APACHE_|NGINX_|MALLOC_|GLIBC_|BASH_)/.test(n);
}
