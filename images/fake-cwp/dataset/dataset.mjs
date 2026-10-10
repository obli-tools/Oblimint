// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — the synthetic CWP 1.18 server reproduced by the TEST image
// (docs/P5-PLAN.md §16, layout of docs/cwp/CWP-MAP.md). SINGLE SOURCE OF TRUTH:
// build/generate.mjs renders every file / SQL row / Linux user from it at image
// build time, check/check-dataset.mjs validates it statically (Windows), and
// dataset/expected-inventory.json (what the panel discovery must find) is
// derived from it (`node check/check-dataset.mjs --write-expected`).
//
// Values are synthetic only: accounts acct1…acct6, domains *.example / *.test,
// public IPs 203.0.113.0/24 (source), 192.0.2.0/24 / 198.51.100.0/24 (others),
// LAN 10.0.0.0/24 / 192.168.1.0/24. Passwords are KNOWN TEST PASSWORDS (listed in
// README.md): the image is never shipped, never managed by the panel.
// ─────────────────────────────────────────────────────────────────────────────

export const SERVER = {
  hostname: 'host.srvdomain.test',
  serverDomain: 'srvdomain.test',
  publicIp: '203.0.113.10',
  privateIp: '10.99.0.2',
  apachePort: 8181,
  apacheSslPort: 8443,
  varnishPort: 82,
  cwpVersion: '1.18',
  cwpPro: true,
  webserverSetup: 'nginx-varnish-apache',
  /** /usr/local/bin/php (suPHP default handler + CLI). */
  phpDefault: '8.3',
  phpDefaultFull: '8.3.0',
  /** /opt/alt/phpXX (CGI / CLI) and /opt/alt/php-fpmXX (FPM) present. */
  phpAlt: ['56', '72', '73', '74', '81', '83'],
  phpFpm: ['56', '74', '81', '83'],
  nameservers: [
    { name: 'ns3.srvdomain.test', ip: '203.0.113.11' },
    { name: 'ns4.srvdomain.test', ip: '203.0.113.12' },
  ],
  mysql: {
    rootPassword: 'FakeCwp-root-2026',
    postfixPassword: 'FakeCwp-postfix-2026',
    roundcubePassword: 'FakeCwp-roundcube-2026',
  },
  /** TSIG key of the dynamic zone (generated at build, never read by the panel). */
  dnsUpdateKey: 'cwp-updater',
  /** Extra prefixes of /usr/local/cwp/.conf/mysql_user_prefix.conf (format assumed: one per line). */
  extraDbPrefixes: ['acct1', 'acct2', 'acct3', 'acct5'],
};

// ── packages (root_cwp.packages, real values of the source: non sensitive) ────

export const PACKAGES = [
  {
    id: 1, name: 'default', disk_quota: '20000', bandwidth: '100000', ftp_accounts: '10', email_accounts: '10',
    email_lists: '10', databases: '10', sub_domains: '10', parked_domains: '10', addons_domains: '10',
    hourly_emails: '200', reseller: '', accounts: '', cgroups: null, nproc: '40', apache_nproc: '40', inode: '0', nofile: '150',
  },
  {
    id: 2, name: 'UNLIMITED', disk_quota: '999999', bandwidth: '-1', ftp_accounts: '-1', email_accounts: '-1',
    email_lists: '-1', databases: '-1', sub_domains: '-1', parked_domains: '-1', addons_domains: '-1',
    hourly_emails: '999999', reseller: '', accounts: '', cgroups: null, nproc: '40', apache_nproc: '40', inode: '0', nofile: '150',
  },
];

// ── CWP accounts (root_cwp.user + Linux user + /home/<u>) ──────────────────────

export const ACCOUNTS = [
  {
    id: 1, username: 'acct1', uid: 1001, package: '2', mainDomain: 'alpha.example', email: 'owner1@example.net',
    setupDate: '2025-09-05 19:11:44', bandwidth: '1', shell: '/bin/bash', suspended: false,
    linuxPassword: 'FakeCwp-acct1-linux', authorizedKeys: 2,
    /** php.ini (suPHP_ConfigPath = home) and .user.ini files, relative to the home. */
    phpIni: ['php.ini'],
    fpmPools: true,
    reseller: '',
  },
  {
    id: 2, username: 'acct2', uid: 1002, package: '2', mainDomain: 'gamma.test', email: 'owner2@example.net',
    setupDate: '2025-09-05 19:20:02', bandwidth: '1', shell: '/sbin/nologin', suspended: false,
    linuxPassword: 'FakeCwp-acct2-linux', authorizedKeys: 0, phpIni: [], fpmPools: true, reseller: '',
  },
  {
    id: 3, username: 'acct3', uid: 1003, package: '1', mainDomain: 'epsilon.example', email: 'owner3@example.org',
    setupDate: '2025-09-05 23:28:15', bandwidth: '', shell: '/sbin/nologin', suspended: false,
    linuxPassword: 'FakeCwp-acct3-linux', authorizedKeys: 0, phpIni: ['public_html/.user.ini'], fpmPools: false, reseller: '',
  },
  {
    id: 4, username: 'acct4', uid: 1004, package: '1', mainDomain: 'acct4.srvdomain.test', email: 'owner4@example.org',
    setupDate: '2025-09-06 08:02:51', bandwidth: '', shell: '/sbin/nologin', suspended: true,
    linuxPassword: 'FakeCwp-acct4-linux', authorizedKeys: 0, phpIni: [], fpmPools: false, reseller: '',
  },
  {
    id: 5, username: 'acct5', uid: 1005, package: '2', mainDomain: 'theta.test', email: 'owner5@example.com',
    setupDate: '2025-09-06 10:44:09', bandwidth: '1', shell: '/sbin/nologin', suspended: false,
    linuxPassword: 'FakeCwp-acct5-linux', authorizedKeys: 0, phpIni: [], fpmPools: false, reseller: '',
  },
  {
    id: 6, username: 'acct6', uid: 1006, package: '1', mainDomain: 'iota.example', email: 'owner6@example.com',
    setupDate: '2025-09-07 17:31:27', bandwidth: '', shell: '/sbin/nologin', suspended: false,
    linuxPassword: 'FakeCwp-acct6-linux', authorizedKeys: 0, phpIni: ['php.ini', 'public_html/.user.ini'], fpmPools: false, reseller: '',
  },
];

/** Linux users outside CWP (UID ≥ 1000 without a root_cwp.user row) — CWP-MAP §4 (a). */
export const LINUX_USERS = [
  // Technical user running Node services from another account's home (/home/acct2/node/*).
  { username: 'svcnode', uid: 1101, home: '/home/svcnode', shell: '/bin/bash', linuxPassword: 'FakeCwp-svcnode-linux', authorizedKeys: 0, createHome: true },
  // Interactive administration user.
  { username: 'admin2', uid: 1102, home: '/home/admin2', shell: '/bin/bash', linuxPassword: 'FakeCwp-admin2-linux', authorizedKeys: 1, createHome: true },
  // UID ≥ 1000 with home '/' (CWP-MAP: "un UID 1018 avec home /").
  { username: 'ghost', uid: 1103, home: '/', shell: '/sbin/nologin', linuxPassword: null, authorizedKeys: 0, createHome: false },
];

// ── domains: one entry per root_cwp row (user.domain / domains / subdomains) ──
//
// web.serving   site | proxy | disabled
// web.php       { handler: suphp | php-fpm | nginx-fpm, fpm?: 'XX' } (suphp → default 8.3 unless the root .htaccess says otherwise)
// web.htaccess  { root?: 'phpXX', subdirs?: { '<rel dir>': 'phpXX' } }  (AddHandler application/x-httpd-phpXX .php)
// web.proxy     { scheme, host, port, websocket, via: nginx-vhost | webservers-json }
// web.apache    an Apache vhost exists (nginx → Apache :8181) — parked / proxies / nginx-fpm have none
// web.ssl       name of the certificate (/etc/pki/tls/certs/<name>.cert) — an .ssl.conf vhost is rendered
// web.json      ~/.conf/webservers/<fqdn>.conf content (null = absent → global defaults)
// app           docroot content: wordpress | laravel | static | php | git-static | none

export const DOMAINS = [
  // ── acct1 ──────────────────────────────────────────────────────────────────
  {
    fqdn: 'alpha.example', kind: 'main', account: 'acct1',
    web: {
      serving: 'site', docroot: '/home/acct1/public_html', php: { handler: 'suphp' },
      htaccess: { subdirs: { legacy: 'php74' } }, apache: true, www: true, ssl: 'alpha.example', subServers: true,
      // TRAP: the JSON claims FPM 7.2 but the Apache vhost has no SetHandler → effective = suPHP default 8.3.
      json: {
        'nginx_template-type': 'default', 'nginx_template-name': 'default', 'varnish_template-name': 'default',
        'apache_template-type': 'php-fpm', 'apache_template-name': 'all_methods', 'php-fpm_ver': '72',
        nginx: true, varnish: false, 'php-fpm': false, 'apache-additional': true,
      },
    },
    app: { type: 'wordpress', db: 'acct1_wp', dbUser: 'acct1_wp', blogname: 'Alpha (fake-cwp)', addonsWp: true },
  },
  {
    // Parked with its OWN nginx vhost (serving the main docroot) and no Apache vhost (CWP-MAP §5).
    fqdn: 'alpha-alias.example', kind: 'parked', account: 'acct1', path: '/home/acct1/public_html', setupTime: '2025-09-05 23:34:42',
    web: { serving: 'site', docroot: '/home/acct1/public_html', php: { handler: 'suphp' }, apache: false, www: true, ssl: null, json: null },
    app: null,
  },
  {
    fqdn: 'beta.example', kind: 'addon', account: 'acct1', path: '/home/acct1/beta.example', setupTime: '2025-09-05 23:34:28',
    web: {
      serving: 'site', docroot: '/home/acct1/beta.example', php: { handler: 'php-fpm', fpm: '74' }, apache: true, www: true,
      ssl: 'beta.example', subServers: true,
      json: {
        'nginx_template-type': 'default', 'nginx_template-name': 'default', 'varnish_template-name': 'default',
        'apache_template-type': 'php-fpm', 'apache_template-name': 'all_methods', 'php-fpm_ver': '74',
        nginx: true, varnish: false, 'php-fpm': true, 'apache-additional': true,
      },
    },
    app: { type: 'php', title: 'Beta (PHP-FPM 7.4)' },
  },
  {
    // Docroot NESTED in the main docroot → a separate site (docrootNested).
    fqdn: 'blog.alpha.example', kind: 'subdomain', account: 'acct1', sub: 'blog', parent: 'alpha.example',
    path: '/home/acct1/public_html/blog', setupTime: '2025-09-05 23:30:03',
    web: { serving: 'site', docroot: '/home/acct1/public_html/blog', php: { handler: 'suphp' }, apache: true, www: true, ssl: null, json: null },
    app: { type: 'php', title: 'Blog (nested docroot)' },
  },
  {
    // Laravel: non-standard /home/u/<sub>/public, nginx template php-fpm (fastcgi_pass php-fpm81), no Apache vhost.
    fqdn: 'app.alpha.example', kind: 'subdomain', account: 'acct1', sub: 'app', parent: 'alpha.example',
    path: '/home/acct1/app/public', setupTime: '2025-09-05 23:31:10',
    web: {
      serving: 'site', docroot: '/home/acct1/app/public', php: { handler: 'nginx-fpm', fpm: '81' }, apache: false, www: true,
      ssl: 'app.alpha.example', template: 'php-fpm',
      json: { 'nginx_template-type': 'php-fpm', 'nginx_template-name': 'default', 'php-fpm_ver': '81', nginx: true, 'php-fpm': true },
    },
    app: { type: 'laravel', root: '/home/acct1/app' },
  },
  {
    // Proxy to the source's OWN Node app (127.0.0.1:3001, systemd unit acct1-api.service): proxyLocalService.
    fqdn: 'api.alpha.example', kind: 'subdomain', account: 'acct1', sub: 'api', parent: 'alpha.example',
    path: '/home/acct1/api', setupTime: '2025-09-05 23:31:44',
    web: {
      serving: 'proxy', docroot: '/home/acct1/api', apache: false, www: true, ssl: null, json: null,
      proxy: { scheme: 'http', host: '127.0.0.1', port: 3001, websocket: false, via: 'nginx-vhost' },
    },
    app: { type: 'node-api' },
  },
  {
    // Sub-label containing a dot (root_cwp.subdomains.subdomain = 'a.b'); no www alias.
    fqdn: 'a.b.alpha.example', kind: 'subdomain', account: 'acct1', sub: 'a.b', parent: 'alpha.example',
    path: '/home/acct1/a.b.alpha.example', setupTime: '2025-09-06 07:12:00',
    web: { serving: 'site', docroot: '/home/acct1/a.b.alpha.example', php: { handler: 'suphp' }, apache: true, www: false, ssl: null, json: null },
    app: { type: 'static', title: 'a.b (dotted sub-label)' },
  },

  // ── acct2 ──────────────────────────────────────────────────────────────────
  {
    fqdn: 'gamma.test', kind: 'main', account: 'acct2',
    web: { serving: 'site', docroot: '/home/acct2/public_html', php: { handler: 'suphp' }, apache: true, www: true, ssl: 'gamma.test', subServers: true, json: null },
    app: { type: 'git-static', title: 'Gamma (static + .git)' },
  },
  {
    // Parked with its own nginx vhost that is a PROXY (LAN target), no Apache vhost.
    fqdn: 'gamma-alias.test', kind: 'parked', account: 'acct2', path: '/home/acct2/public_html', setupTime: '2025-09-06 09:01:13',
    web: {
      serving: 'proxy', docroot: '/home/acct2/public_html', apache: false, www: true, ssl: null, json: null,
      proxy: { scheme: 'http', host: '192.168.1.20', port: 8080, websocket: false, via: 'nginx-vhost' },
    },
    app: null,
  },
  {
    // Addon with a FREE path + Apache SetHandler php-fpm56 (PHP 5.6 → phpNoBase).
    fqdn: 'delta.test', kind: 'addon', account: 'acct2', path: '/home/acct2/sites/delta', setupTime: '2025-09-06 09:04:51',
    web: {
      serving: 'site', docroot: '/home/acct2/sites/delta', php: { handler: 'php-fpm', fpm: '56' }, apache: true, www: true,
      ssl: null, subServers: true,
      json: {
        'nginx_template-type': 'default', 'nginx_template-name': 'default', 'varnish_template-name': 'default',
        'apache_template-type': 'php-fpm', 'apache_template-name': 'all_methods', 'php-fpm_ver': '56',
        nginx: true, varnish: true, 'php-fpm': true, 'apache-additional': true,
      },
    },
    app: { type: 'php', title: 'Delta (PHP-FPM 5.6)' },
  },
  {
    // The only sub-domain on an ADDON domain.
    fqdn: 'm.delta.test', kind: 'subdomain', account: 'acct2', sub: 'm', parent: 'delta.test',
    path: '/home/acct2/m.delta.test', setupTime: '2025-09-06 09:05:30',
    web: { serving: 'site', docroot: '/home/acct2/m.delta.test', php: { handler: 'suphp' }, apache: true, www: true, ssl: null, json: null },
    app: { type: 'static', title: 'm.delta (sub-domain of an addon)' },
  },
  {
    fqdn: 'nas.gamma.test', kind: 'subdomain', account: 'acct2', sub: 'nas', parent: 'gamma.test',
    path: '/home/acct2/nas.gamma.test', setupTime: '2025-09-06 09:10:00',
    web: {
      serving: 'proxy', docroot: '/home/acct2/nas.gamma.test', apache: false, www: true, ssl: null, json: null,
      proxy: { scheme: 'http', host: '192.168.1.20', port: 5000, websocket: false, via: 'nginx-vhost' },
    },
    app: null,
  },
  {
    fqdn: 'cloud.gamma.test', kind: 'subdomain', account: 'acct2', sub: 'cloud', parent: 'gamma.test',
    path: '/home/acct2/cloud.gamma.test', setupTime: '2025-09-06 09:11:00',
    web: {
      serving: 'proxy', docroot: '/home/acct2/cloud.gamma.test', apache: false, www: true, ssl: 'cloud.gamma.test', json: null,
      proxy: { scheme: 'https', host: '198.51.100.25', port: 443, websocket: false, via: 'nginx-vhost' },
    },
    app: null,
  },
  {
    // Websocket proxy through a CUSTOM nginx template (proxy_websocket).
    fqdn: 'ws.gamma.test', kind: 'subdomain', account: 'acct2', sub: 'ws', parent: 'gamma.test',
    path: '/home/acct2/ws.gamma.test', setupTime: '2025-09-06 09:12:00',
    web: {
      serving: 'proxy', docroot: '/home/acct2/ws.gamma.test', apache: false, www: true, ssl: null, template: 'proxy_websocket',
      json: { 'nginx_template-type': 'proxy', 'nginx_template-name': 'proxy_websocket', nginx: true },
      proxy: { scheme: 'http', host: '10.0.0.30', port: 8080, websocket: true, via: 'nginx-vhost' },
    },
    app: null,
  },
  {
    // Proxy declared by the JSON custom-ip / custom-port variant (CWP-MAP §6).
    fqdn: 'cam.gamma.test', kind: 'subdomain', account: 'acct2', sub: 'cam', parent: 'gamma.test',
    path: '/home/acct2/cam.gamma.test', setupTime: '2025-09-06 09:13:00',
    web: {
      serving: 'proxy', docroot: '/home/acct2/cam.gamma.test', apache: false, www: true, ssl: null,
      json: { 'nginx_template-type': 'default', 'nginx_template-name': 'default', 'custom-ip': '192.168.1.40', 'custom-port': '8123', nginx: true },
      proxy: { scheme: 'http', host: '192.168.1.40', port: 8123, websocket: false, via: 'webservers-json' },
    },
    app: null,
  },
  {
    // nginx → Varnish :82 with a CUSTOM backend (10.0.0.40:8080) → varnish-backend (outside CWP).
    fqdn: 'shop.gamma.test', kind: 'subdomain', account: 'acct2', sub: 'shop', parent: 'gamma.test',
    path: '/home/acct2/shop.gamma.test', setupTime: '2025-09-06 09:14:00',
    web: {
      serving: 'site', docroot: '/home/acct2/shop.gamma.test', php: { handler: 'suphp' }, apache: true, www: true, ssl: null,
      varnish: { backendHost: '10.0.0.40', backendPort: 8080 },
      json: {
        'nginx_template-type': 'default', 'nginx_template-name': 'default', 'varnish_template-name': 'default',
        nginx: true, varnish: true, 'apache-additional': true,
      },
    },
    app: { type: 'php', title: 'Shop (behind Varnish)' },
  },

  // ── acct3 (package default) ────────────────────────────────────────────────
  {
    // WordPress whose ROOT .htaccess forces PHP 5.6 (suPHP AddHandler) → site version 5.6 (source htaccess).
    fqdn: 'epsilon.example', kind: 'main', account: 'acct3',
    web: {
      serving: 'site', docroot: '/home/acct3/public_html', php: { handler: 'suphp' }, htaccess: { root: 'php56' },
      apache: true, www: true, ssl: 'epsilon.example', subServers: true, json: null,
    },
    app: { type: 'wordpress', db: 'acct3_wp', dbUser: 'acct3_wp', blogname: 'Epsilon (latin1, PHP 5.6)', addonsWp: true, legacyMysql: true },
  },
  {
    // Custom nginx template named after a domain (customTemplate).
    fqdn: 'legacy.epsilon.example', kind: 'subdomain', account: 'acct3', sub: 'legacy', parent: 'epsilon.example',
    path: '/home/acct3/legacy.epsilon.example', setupTime: '2025-09-06 11:00:00',
    web: {
      serving: 'site', docroot: '/home/acct3/legacy.epsilon.example', php: { handler: 'suphp' }, apache: true, www: true,
      ssl: null, template: 'epsilon_example',
      json: { 'nginx_template-type': 'default', 'nginx_template-name': 'epsilon_example', nginx: true },
    },
    app: { type: 'static', title: 'Legacy (custom nginx template)' },
  },
  {
    // Disabled vhosts (suffix .disabled) → serving disabled.
    fqdn: 'old.example', kind: 'addon', account: 'acct3', path: '/home/acct3/old.example', setupTime: '2025-09-06 11:20:00',
    web: { serving: 'disabled', docroot: '/home/acct3/old.example', php: { handler: 'suphp' }, apache: true, www: true, ssl: null, subServers: true, json: null },
    app: { type: 'static', title: 'Old (disabled vhost)' },
  },

  // ── acct4 (SUSPENDED, package default) ─────────────────────────────────────
  {
    fqdn: 'acct4.srvdomain.test', kind: 'main', account: 'acct4',
    web: { serving: 'site', docroot: '/home/acct4/public_html', php: { handler: 'suphp' }, apache: true, www: true, ssl: null, subServers: true, json: null },
    app: { type: 'php', title: 'acct4 (suspended account)' },
  },
  {
    // DUPLICATE: the same fqdn as acct4's main domain, as a sub-domain row of the server domain (CWP-MAP §5).
    fqdn: 'acct4.srvdomain.test', kind: 'subdomain', account: 'acct4', sub: 'acct4', parent: 'srvdomain.test',
    path: '/home/acct4/public_html', setupTime: '2025-09-06 08:03:10', duplicateRow: true,
    web: null, app: null,
  },

  // ── acct5 (symlink traps, aberrant docroot) ────────────────────────────────
  {
    // public_html/.htaccess and ~/php.ini are SYMLINKS to /etc/shadow (MG10: never read).
    fqdn: 'theta.test', kind: 'main', account: 'acct5',
    web: { serving: 'site', docroot: '/home/acct5/public_html', php: { handler: 'suphp' }, apache: true, www: true, ssl: null, subServers: true, json: null },
    app: { type: 'php', title: 'Theta (symlink traps)', traps: true },
  },
  {
    // Aberrant path /home/<u>/home/<other>/… (CWP-MAP §5).
    fqdn: 'files.theta.test', kind: 'subdomain', account: 'acct5', sub: 'files', parent: 'theta.test',
    path: '/home/acct5/home/acct6/files', setupTime: '2025-09-06 12:00:00',
    web: { serving: 'site', docroot: '/home/acct5/home/acct6/files', php: { handler: 'suphp' }, apache: true, www: true, ssl: null, json: null },
    app: { type: 'php', title: 'Files (aberrant docroot)' },
  },
  {
    // The DOCROOT ITSELF is a symlink to /etc (MG10: rsync must refuse to pull it).
    fqdn: 'link.theta.test', kind: 'subdomain', account: 'acct5', sub: 'link', parent: 'theta.test',
    path: '/home/acct5/linkroot', setupTime: '2025-09-06 12:05:00',
    web: { serving: 'site', docroot: '/home/acct5/linkroot', php: { handler: 'suphp' }, apache: true, www: true, ssl: null, json: null },
    app: { type: 'symlink-docroot', target: '/etc' },
  },

  // ── acct6 ──────────────────────────────────────────────────────────────────
  {
    fqdn: 'iota.example', kind: 'main', account: 'acct6',
    web: { serving: 'site', docroot: '/home/acct6/public_html', php: { handler: 'suphp' }, apache: true, www: true, ssl: null, subServers: true, json: null },
    app: { type: 'php', title: 'Iota (.user.ini + php.ini)' },
  },
];

// ── DNS (BIND 9.11, zones declared inline in /etc/named.conf) ────────────────
//
// format   cwp (CWP free text, like docs/cwp/zone-sample.anon.db) | canonical (rewritten by BIND)
// standard the CWP default records of a hosted domain (@ A, MX, mail/smtp/… CNAME, webmail/cpanel A, SPF, DMARC, DKIM)
// extra    additional records (name relative to the zone, '@' = apex)

export const ZONES = [
  { name: 'alpha.example', account: 'acct1', standard: true, mail: true,
    extra: [
      ['blog', 14400, 'CNAME', 'alpha.example.'],
      ['app', 14400, 'A', '203.0.113.10'],
      ['api', 300, 'A', '203.0.113.10'],
      ['a.b', 14400, 'A', '203.0.113.10'],
      ['@', 3600, 'CAA', '0 issue "letsencrypt.org"'],
      ['_imaps._tcp', 14400, 'SRV', '0 1 993 alpha.example.'],
    ] },
  { name: 'alpha-alias.example', account: 'acct1', standard: true, mail: false, extra: [] },
  { name: 'beta.example', account: 'acct1', standard: true, mail: true, extra: [['@', 120, 'TXT', '"google-site-verification=fake-cwp-token"']] },
  { name: 'gamma.test', account: 'acct2', standard: true, mail: false,
    extra: [
      ['nas', 14400, 'A', '203.0.113.10'],
      ['cloud', 14400, 'A', '203.0.113.10'],
      ['ws', 14400, 'A', '203.0.113.10'],
      ['cam', 14400, 'A', '203.0.113.10'],
      ['shop', 14400, 'A', '203.0.113.10'],
      // A record pointing to ANOTHER machine: kept as is (zoneForeignIp).
      ['home', 300, 'A', '192.0.2.50'],
    ] },
  { name: 'gamma-alias.test', account: 'acct2', standard: true, mail: false, extra: [] },
  { name: 'delta.test', account: 'acct2', standard: true, mail: false, extra: [['m', 14400, 'A', '203.0.113.10']] },
  { name: 'epsilon.example', account: 'acct3', standard: true, mail: true, extra: [['legacy', 14400, 'A', '203.0.113.10']] },
  { name: 'old.example', account: 'acct3', standard: true, mail: false, extra: [] },
  { name: 'acct4.srvdomain.test', account: 'acct4', standard: true, mail: true, extra: [] },
  { name: 'theta.test', account: 'acct5', standard: true, mail: false,
    extra: [
      ['files', 14400, 'A', '203.0.113.10'],
      ['link', 14400, 'A', '203.0.113.10'],
      // Types not imported by the panel (HINFO) and an AAAA to a documentation prefix.
      ['@', 14400, 'HINFO', '"PC" "LINUX"'],
      ['v6', 86400, 'AAAA', '2001:db8::10'],
    ] },
  // Rewritten by BIND (canonical format, '; 4 hours' comments): CWP-MAP §9.
  { name: 'iota.example', account: 'acct6', standard: true, mail: true, format: 'canonical', extra: [] },
  // Server zone: DYNAMIC (allow-update key cwp-updater) — the entrypoint adds records with nsupdate at first start,
  // so a .jnl exists and the .db file is STALE (CWP-MAP §9).
  { name: 'srvdomain.test', account: null, standard: false, mail: false, dynamic: true,
    records: [
      ['@', 14400, 'A', '203.0.113.10'],
      ['host', 14400, 'A', '203.0.113.10'],
      ['ns3', 14400, 'A', '203.0.113.11'],
      ['ns4', 14400, 'A', '203.0.113.12'],
      ['@', 14400, 'MX', '10 host.srvdomain.test.'],
      ['@', 14400, 'TXT', '"v=spf1 +a +mx +ip4:203.0.113.10 ~all"'],
    ],
    /** Added by nsupdate at first start: present ONLY through the journal (named-checkzone -j / AXFR). */
    dynamicRecords: [
      ['dyn-added', 300, 'A', '192.0.2.77'],
      ['_acme-challenge', 120, 'TXT', '"fake-cwp-dynamic-update"'],
    ] },
  { name: 'ns3.srvdomain.test', account: null, standard: false, mail: false, records: [['@', 14400, 'A', '203.0.113.11']] },
  { name: 'ns4.srvdomain.test', account: null, standard: false, mail: false, records: [['@', 14400, 'A', '203.0.113.12']] },
];

/** /var/named files that are NOT declared zones. */
export const ZONE_FILES_EXTRA = [
  // Orphan zone file (no zone statement): zoneOrphan / dns-orphan-zone.
  { file: 'forgotten.example.db', zone: 'forgotten.example', kind: 'orphan' },
  // Backup copy left by CWP (not a .db file).
  { file: 'epsilon.example.db.restore', zone: 'epsilon.example', kind: 'restore' },
];

// ── MariaDB 10.3 client databases (InnoDB + MyISAM + MEMORY, latin1 / utf8 / utf8mb4) ──
//
// Each database: charset/collation of CREATE DATABASE + raw SQL (DDL + data + triggers + views with
// client DEFINERs). Hex literals keep the bytes exact whatever the client charset.

export const DATABASES = [
  {
    name: 'acct1_wp', account: 'acct1', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci',
    sql: `
CREATE TABLE wp_options (
  option_id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  option_name varchar(191) NOT NULL DEFAULT '',
  option_value longtext NOT NULL,
  autoload varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (option_id), UNIQUE KEY option_name (option_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO wp_options (option_name, option_value) VALUES
  ('siteurl', 'https://alpha.example'), ('home', 'https://alpha.example'), ('blogname', 'Alpha (fake-cwp)'),
  ('blogdescription', 'Déjà vu — ünïcödé ✓');
CREATE TABLE wp_posts (
  ID bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  post_title text NOT NULL,
  post_content longtext NOT NULL,
  post_status varchar(20) NOT NULL DEFAULT 'publish',
  post_modified datetime NOT NULL DEFAULT '2000-01-01 00:00:00',
  PRIMARY KEY (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO wp_posts (post_title, post_content, post_modified) VALUES
  ('Bonjour tout le monde', 'Premier article — emoji 🚀', '2024-01-15 10:00:00'),
  ('Second', 'Contenu', '2024-02-01 08:30:00');
CREATE TABLE wp_post_log (id int NOT NULL AUTO_INCREMENT, post_id bigint unsigned NOT NULL, at datetime NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE DEFINER=\`acct1_wp\`@\`localhost\` TRIGGER wp_posts_after_insert AFTER INSERT ON wp_posts FOR EACH ROW INSERT INTO wp_post_log (post_id, at) VALUES (NEW.ID, NOW());
CREATE DEFINER=\`acct1_wp\`@\`localhost\` SQL SECURITY DEFINER VIEW wp_published AS SELECT ID, post_title FROM wp_posts WHERE post_status = 'publish';
`,
  },
  {
    name: 'acct1_app', account: 'acct1', charset: 'utf8', collation: 'utf8_general_ci',
    sql: `
CREATE TABLE users (id int unsigned NOT NULL AUTO_INCREMENT, email varchar(190) NOT NULL, name varchar(100) NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
INSERT INTO users (email, name) VALUES ('jane@example.com', 'Jane Doe'), ('john@example.com', 'John Doe');
-- MEMORY table: structure only on the target (content is lost at every restart anyway).
CREATE TABLE cache_mem (k varchar(64) NOT NULL, v varchar(255) NOT NULL, PRIMARY KEY (k)) ENGINE=MEMORY DEFAULT CHARSET=utf8;
INSERT INTO cache_mem VALUES ('warm', 'seeded at build — lost at the first restart');
CREATE TABLE legacy_log (id int NOT NULL AUTO_INCREMENT, line varchar(255) NOT NULL, PRIMARY KEY (id)) ENGINE=MyISAM DEFAULT CHARSET=utf8;
INSERT INTO legacy_log (line) VALUES ('myisam row 1'), ('myisam row 2');
CREATE TABLE audit (id int NOT NULL AUTO_INCREMENT, user_id int unsigned NOT NULL, at datetime NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE DEFINER=\`acct1_app\`@\`localhost\` TRIGGER users_ai AFTER INSERT ON users FOR EACH ROW INSERT INTO audit (user_id, at) VALUES (NEW.id, NOW());
`,
  },
  {
    name: 'acct1_stats', account: 'acct1', charset: 'latin1', collation: 'latin1_swedish_ci',
    sql: `
CREATE TABLE hits (day date NOT NULL, page varchar(200) NOT NULL, n int NOT NULL, PRIMARY KEY (day, page)) ENGINE=MyISAM DEFAULT CHARSET=latin1;
INSERT INTO hits VALUES ('2024-01-01', '/', 42), ('2024-01-01', '/contact', 3);
-- View whose DEFINER has the host '%' (CWP-MAP §7: 2 DEFINERs @%).
CREATE DEFINER=\`acct1_app\`@\`%\` SQL SECURITY DEFINER VIEW daily AS SELECT day, SUM(n) AS total FROM hits GROUP BY day;
`,
  },
  {
    name: 'acct2_shop', account: 'acct2', charset: 'utf8mb4', collation: 'utf8mb4_general_ci',
    sql: `
CREATE TABLE products (id int NOT NULL AUTO_INCREMENT, sku varchar(32) NOT NULL, label varchar(200) NOT NULL, price decimal(10,2) NOT NULL, stock int NOT NULL DEFAULT 0, PRIMARY KEY (id), UNIQUE KEY sku (sku)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO products (sku, label, price, stock) VALUES ('A-1', 'Café moulu', 4.50, 10), ('B-2', 'Thé vert', 3.20, 0);
CREATE TABLE stock_moves (id int NOT NULL AUTO_INCREMENT, product_id int NOT NULL, delta int NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- DEFINER = the BARE account user (acct2@localhost).
CREATE DEFINER=\`acct2\`@\`localhost\` TRIGGER products_au AFTER UPDATE ON products FOR EACH ROW INSERT INTO stock_moves (product_id, delta) VALUES (NEW.id, NEW.stock - OLD.stock);
`,
  },
  {
    name: 'acct2_legacy', account: 'acct2', charset: 'latin1', collation: 'latin1_bin',
    sql: `
CREATE TABLE notes (id int NOT NULL AUTO_INCREMENT, body text NOT NULL, PRIMARY KEY (id)) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
INSERT INTO notes (body) VALUES (X'4E6F746520E974E920313939382E');
`,
  },
  {
    // latin1 tables holding UTF-8 bytes (old WordPress: DOUBLE ENCODING case, R-MIG-CHARSET).
    name: 'acct3_wp', account: 'acct3', charset: 'latin1', collation: 'latin1_swedish_ci',
    sql: `
CREATE TABLE wp_options (
  option_id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  option_name varchar(191) NOT NULL DEFAULT '',
  option_value longtext NOT NULL,
  autoload varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (option_id), UNIQUE KEY option_name (option_name)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
-- blogname: the UTF-8 bytes of 'Café épicé' stored in a latin1 column (C3 A9 → 'Ã©' seen as latin1).
INSERT INTO wp_options (option_name, option_value) VALUES
  ('siteurl', 'https://epsilon.example'), ('home', 'https://epsilon.example'),
  ('blogname', X'436166C3A920C3A9706963C3A9'),
  ('blogdescription', X'56726169206C6174696E3120E9E8E0');
CREATE TABLE wp_posts (ID bigint(20) unsigned NOT NULL AUTO_INCREMENT, post_title text NOT NULL, post_content longtext NOT NULL, post_status varchar(20) NOT NULL DEFAULT 'publish', PRIMARY KEY (ID)) ENGINE=MyISAM DEFAULT CHARSET=latin1;
INSERT INTO wp_posts (post_title, post_content) VALUES (X'52C3A9756E696F6E', X'436F6E74656E7520656E636F64C3A920646575782066C3B26973');
`,
  },
  {
    name: 'acct3_crm', account: 'acct3', charset: 'utf8', collation: 'utf8_general_ci',
    sql: `
CREATE TABLE contacts (id int NOT NULL AUTO_INCREMENT, name varchar(100) NOT NULL, email varchar(190) NOT NULL, updated datetime NOT NULL DEFAULT '2000-01-01 00:00:00', PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8;
INSERT INTO contacts (name, email) VALUES ('Zoé', 'zoe@example.org'), ('Ana', 'ana@example.org');
CREATE DEFINER=\`acct3_crm\`@\`%\` TRIGGER contacts_bu BEFORE UPDATE ON contacts FOR EACH ROW SET NEW.updated = NOW();
CREATE DEFINER=\`acct3_crm\`@\`localhost\` SQL SECURITY DEFINER VIEW contact_emails AS SELECT email FROM contacts;
-- DEFINER that is NOT a user of this account (root): rewritten by the panel (dbDefinerForeign).
CREATE DEFINER=\`root\`@\`localhost\` SQL SECURITY INVOKER VIEW contact_count AS SELECT COUNT(*) AS n FROM contacts;
`,
  },
  {
    name: 'acct5_data', account: 'acct5', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci',
    sql: `
CREATE TABLE measures (id bigint NOT NULL AUTO_INCREMENT, sensor varchar(40) NOT NULL, value double NOT NULL, at datetime NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO measures (sensor, value, at) VALUES ('t1', 21.5, '2024-03-01 12:00:00'), ('t2', 19.25, '2024-03-01 12:00:00');
CREATE TABLE sessions (id varchar(64) NOT NULL, data varchar(2000) NOT NULL, PRIMARY KEY (id)) ENGINE=MEMORY DEFAULT CHARSET=utf8mb4;
`,
  },
  {
    name: 'acct6_site', account: 'acct6', charset: 'latin1', collation: 'latin1_swedish_ci',
    sql: `
CREATE TABLE pages (id int NOT NULL AUTO_INCREMENT, slug varchar(100) NOT NULL, title varchar(200) NOT NULL, PRIMARY KEY (id)) ENGINE=MyISAM DEFAULT CHARSET=latin1;
INSERT INTO pages (slug, title) VALUES ('index', 'Accueil'), ('contact', X'436F6E74616374202620616363E873');
CREATE TABLE prefs (k varchar(40) NOT NULL, v varchar(200) NOT NULL, PRIMARY KEY (k)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
INSERT INTO prefs VALUES ('theme', 'dark');
`,
  },
  {
    // Prefix matching NO CWP account: orphan database (dbOrphan).
    name: 'oldclient_db', account: null, charset: 'latin1', collation: 'latin1_swedish_ci',
    sql: `
CREATE TABLE t (id int NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=latin1;
INSERT INTO t VALUES (1), (2), (3);
`,
  },
];

/** CWP system databases (schema dumps of the source in seed/schemas/, no row but root_cwp / postfix). */
export const SYSTEM_DATABASES = ['root_cwp', 'postfix', 'postfix_policyd', 'roundcube', 'oauthv2', 'root_cpmigrations'];

// Privilege sets of mysql.db (GRANT OPTION never given to clients).
const ALL = 'ALL PRIVILEGES';
const ALL_BUT_ALTER = 'SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, CREATE TEMPORARY TABLES, LOCK TABLES, CREATE VIEW, SHOW VIEW, EXECUTE, EVENT, TRIGGER';

// auth: 'password'  → CREATE USER … IDENTIFIED BY (hash in mysql.user.Password, plugin '')
//       'plugin'    → IDENTIFIED VIA mysql_native_password USING '*HEX' (plugin + authentication_string)
// grants.db is mysql.db.Db EXACTLY as CWP stores it (escaped underscore, LIKE wildcard).
export const DB_USERS = [
  { user: 'acct1', host: 'localhost', account: 'acct1', password: 'FakeCwp-acct1-linux', auth: 'password', grants: [{ db: 'acct1\\_%', privs: ALL }] },
  { user: 'acct1_wp', host: 'localhost', account: 'acct1', password: 'acct1_wp-Db-2026', auth: 'password', grants: [{ db: 'acct1\\_wp', privs: ALL }] },
  // Same user on two hosts with DIFFERENT passwords (dbHostHashMismatch: localhost wins); remote host 10.0.0.%.
  { user: 'acct1_app', host: 'localhost', account: 'acct1', password: 'acct1_app-Db-2026', auth: 'plugin', grants: [{ db: 'acct1\\_app', privs: ALL }] },
  { user: 'acct1_app', host: '10.0.0.%', account: 'acct1', password: 'acct1_app-Remote-2026', auth: 'password', grants: [{ db: 'acct1\\_app', privs: ALL }] },
  // SELECT-only grant (readonly).
  { user: 'acct1_ro', host: 'localhost', account: 'acct1', password: 'acct1_ro-Db-2026', auth: 'password', grants: [{ db: 'acct1\\_stats', privs: 'SELECT' }] },
  { user: 'acct2', host: 'localhost', account: 'acct2', password: 'FakeCwp-acct2-linux', auth: 'password', grants: [{ db: 'acct2\\_%', privs: ALL }] },
  { user: 'acct2_shop', host: 'localhost', account: 'acct2', password: 'acct2_shop-Db-2026', auth: 'plugin', grants: [{ db: 'acct2\\_shop', privs: ALL }] },
  { user: 'acct2_shop', host: '192.168.1.%', account: 'acct2', password: 'acct2_shop-Db-2026', auth: 'password', grants: [{ db: 'acct2\\_shop', privs: ALL }] },
  { user: 'acct3', host: 'localhost', account: 'acct3', password: 'FakeCwp-acct3-linux', auth: 'password', grants: [{ db: 'acct3\\_%', privs: ALL }] },
  // ALL minus ALTER / routines (custom grant → all + dbGrantCustom).
  { user: 'acct3_wp', host: 'localhost', account: 'acct3', password: 'acct3_wp-Db-2026', auth: 'password', grants: [{ db: 'acct3\\_wp', privs: ALL_BUT_ALTER }] },
  { user: 'acct3_crm', host: 'localhost', account: 'acct3', password: 'acct3_crm-Db-2026', auth: 'password', grants: [{ db: 'acct3\\_crm', privs: ALL }] },
  { user: 'acct3_crm', host: '%', account: 'acct3', password: 'acct3_crm-Db-2026', auth: 'password', grants: [{ db: 'acct3\\_crm', privs: ALL }] },
  { user: 'acct5', host: 'localhost', account: 'acct5', password: 'FakeCwp-acct5-linux', auth: 'password', grants: [{ db: 'acct5\\_%', privs: ALL }] },
  { user: 'acct5_data', host: 'localhost', account: 'acct5', password: 'acct5_data-Db-2026', auth: 'password', grants: [{ db: 'acct5\\_data', privs: ALL }] },
  { user: 'acct6', host: 'localhost', account: 'acct6', password: 'FakeCwp-acct6-linux', auth: 'password', grants: [{ db: 'acct6\\_%', privs: ALL }] },
  { user: 'acct6_site', host: 'localhost', account: 'acct6', password: 'acct6_site-Db-2026', auth: 'password', grants: [{ db: 'acct6\\_site', privs: ALL }] },
  // Prefixed user whose prefix is no CWP account (dbUserOrphan).
  { user: 'oldclient_user', host: 'localhost', account: null, password: 'oldclient-Db-2026', auth: 'password', grants: [{ db: 'oldclient\\_db', privs: ALL }] },
];

// ── mail (postfix database + /var/vmail Maildir++) ───────────────────────────

export const MAIL_DOMAINS = [
  { domain: 'alpha.example', account: 'acct1', dirOwner: 'vmail', dirMode: 0o770 },
  // Mail domain on an ADDON domain.
  { domain: 'beta.example', account: 'acct1', dirOwner: 'vmail', dirMode: 0o770 },
  // Older domain directory owned by the account (CWP-MAP §8).
  { domain: 'epsilon.example', account: 'acct3', dirOwner: 'account', dirMode: 0o700 },
  { domain: 'acct4.srvdomain.test', account: 'acct4', dirOwner: 'vmail', dirMode: 0o770 },
  { domain: 'iota.example', account: 'acct6', dirOwner: 'vmail', dirMode: 0o770 },
];

// scheme: SHA512-CRYPT → '{SHA512-CRYPT}' + openssl passwd -6 (120 chars, no rounds=); MD5-CRYPT-BARE → openssl passwd -1 (no prefix)
// folders: INBOX + Maildir++ sub-folders; each message: { folder, subject, seen } — UIDs are kept in dovecot-uidlist.
// quota2: true = a postfix.quota2 row (bytes / messages computed from the messages), null = no row.
export const MAILBOXES = [
  {
    address: 'contact@alpha.example', name: 'Contact Alpha', password: 'Mail-contact-alpha-2026', scheme: 'SHA512-CRYPT',
    quota: 0, active: 1, phone: '+33100000001', emailOther: 'backup@example.net', sieve: true,
    uidValidity: 1700000001, quota2: true,
    messages: [
      { folder: 'INBOX', subject: 'Bienvenue sur alpha.example', seen: true },
      { folder: 'INBOX', subject: 'Facture 2024-001', seen: true },
      { folder: 'INBOX', subject: 'Nouveau message non lu', seen: false, new: true },
      { folder: 'Sent', subject: 'Re: Facture 2024-001', seen: true },
      { folder: 'Spam', subject: 'Gagnez un million', seen: false },
    ],
  },
  {
    address: 'info@alpha.example', name: 'Info', password: 'Mail-info-alpha-2026', scheme: 'SHA512-CRYPT',
    quota: 1073741824, active: 1, phone: '', emailOther: '', sieve: false, uidValidity: 1700000002, quota2: true,
    messages: [{ folder: 'INBOX', subject: 'Question produit', seen: true }],
    // TRAP: absolute symlink inside the maildir (dropped by rsync --safe-links → unsafeLinks).
    symlinkTrap: { name: 'evil-link', target: '/etc/shadow' },
  },
  {
    address: 'old@alpha.example', name: 'Ancienne boîte', password: 'Mail-old-alpha-2026', scheme: 'SHA512-CRYPT',
    quota: 0, active: 0, phone: '', emailOther: '', sieve: false, uidValidity: 1700000003, quota2: null,
    messages: [{ folder: 'INBOX', subject: 'Archive', seen: true }],
  },
  {
    address: 'sales@beta.example', name: 'Sales Beta', password: 'Mail-sales-beta-2026', scheme: 'SHA512-CRYPT',
    quota: 524288000, active: 1, phone: '', emailOther: '', sieve: false, uidValidity: 1700000004, quota2: true,
    messages: [{ folder: 'INBOX', subject: 'Commande 42', seen: true }, { folder: 'Trash', subject: 'Supprimé', seen: true }],
  },
  {
    address: 'admin@epsilon.example', name: 'Admin Epsilon', password: 'Mail-admin-epsilon-2026', scheme: 'SHA512-CRYPT',
    quota: 0, active: 1, phone: '', emailOther: '', sieve: true, uidValidity: 1700000005, quota2: true,
    messages: [{ folder: 'INBOX', subject: 'Rapport mensuel', seen: true }],
  },
  {
    address: 'user@acct4.srvdomain.test', name: 'Compte suspendu', password: 'Mail-user-acct4-2026', scheme: 'SHA512-CRYPT',
    quota: 0, active: 1, phone: '', emailOther: '', sieve: false, uidValidity: 1700000006, quota2: null,
    messages: [{ folder: 'INBOX', subject: 'Avis de suspension', seen: false }],
  },
  {
    // Bare MD5-crypt hash ($1$, no {SCHEME} prefix): default_pass_scheme MD5-CRYPT of dovecot-mysql.conf.
    address: 'legacy@iota.example', name: 'Legacy', password: 'Mail-legacy-iota-2026', scheme: 'MD5-CRYPT-BARE',
    quota: 0, active: 1, phone: '', emailOther: '', sieve: false, uidValidity: 1700000007, quota2: true,
    messages: [{ folder: 'INBOX', subject: 'Ancien message', seen: true }],
  },
];

export const ALIASES = [
  // Forwarder to an EXTERNAL address (aliasExternalTargets).
  { address: 'fwd@alpha.example', goto: 'someone@external.example', domain: 'alpha.example', active: 1 },
  // Several targets (comma separated), active = 3 (CWP variant also accepted by the maps).
  { address: 'team@epsilon.example', goto: 'a@external.example,admin@epsilon.example', domain: 'epsilon.example', active: 3 },
  // Catch-all.
  { address: '@beta.example', goto: 'sales@beta.example', domain: 'beta.example', active: 1 },
];

// ── DKIM (OpenDKIM, selector 'default', keys generated at build) ──────────────

export const DKIM = [
  { domain: 'alpha.example', bits: 2048 },
  { domain: 'beta.example', bits: 2048 },
  { domain: 'epsilon.example', bits: 2048 },
  { domain: 'acct4.srvdomain.test', bits: 2048 },
  // Weak key (dkimWeakKey: a new key is generated by Oblimint, the DNS record changes).
  { domain: 'iota.example', bits: 1024 },
  // Key for a domain WITHOUT any mailbox / mail domain (CWP-MAP §8).
  { domain: 'gamma.test', bits: 2048 },
];

// ── Pure-FTPd virtual users (/etc/pure-ftpd/pureftpd.passwd, 18 fields) ──────

export const FTP_USERS = [
  { login: 'ftp1@alpha.example', account: 'acct1', password: 'Ftp-ftp1-alpha-2026', scheme: 'bcrypt', dir: '/home/acct1/public_html' },
  { login: 'ftp2@alpha.example', account: 'acct1', password: 'Ftp-ftp2-alpha-2026', scheme: 'bcrypt', dir: '/home/acct1' },
  { login: 'dev@gamma.test', account: 'acct2', password: 'Ftp-dev-gamma-2026', scheme: 'bcrypt', dir: '/home/acct2/sites/delta' },
  { login: 'web@epsilon.example', account: 'acct3', password: 'Ftp-web-epsilon-2026', scheme: 'bcrypt', dir: '/home/acct3/public_html' },
  // Non-bcrypt user (MD5-crypt): not adoptable (ftpHashUnsupported).
  { login: 'legacy@iota.example', account: 'acct6', password: 'Ftp-legacy-iota-2026', scheme: 'md5', dir: '/home/acct6' },
];

// ── crontabs (/var/spool/cron/<owner>) ───────────────────────────────────────

export const CRONTABS = [
  {
    owner: 'acct1', fileOwner: 'root', copyInHome: true,
    lines: [
      '*/5 * * * * /usr/local/bin/php -q /home/acct1/public_html/wp-cron.php >/dev/null 2>&1',
      // PHP version hard-coded + redirect INTO the docroot (cronWritesToCode).
      '15 3 * * * /opt/alt/php73/usr/bin/php /home/acct1/app/artisan schedule:run >> /home/acct1/public_html/logs/cron.log 2>&1',
      '@reboot /usr/bin/node /home/acct1/api/server.js >/dev/null 2>&1',
      '#30 4 * * 0 /home/acct1/scripts/backup.sh',
      '* * * * * /home/acct1/scripts/every-minute.sh >/dev/null 2>&1',
    ],
  },
  {
    // The one crontab owned by its user (CWP-MAP §10).
    owner: 'acct3', fileOwner: 'acct3', copyInHome: false,
    lines: [
      '0 */6 * * * /usr/local/bin/php /home/acct3/public_html/wp-cron.php >/dev/null 2>&1',
      '0 2 * * * /opt/alt/php56/usr/bin/php /home/acct3/public_html/tools/cleanup.php',
    ],
  },
  {
    owner: 'root', fileOwner: 'root', copyInHome: false,
    lines: [
      '0 */12 * * * /usr/local/cwp/php71/bin/php -d max_execution_time=1000000 -q /usr/local/cwpsrv/htdocs/resources/admin/include/cron.php',
      '10 3 * * * "/root/.acme.sh"/acme.sh --cron --home "/root/.acme.sh" > /dev/null',
      '0 * * * * /usr/local/bin/sync-dns-zones.sh >/dev/null 2>&1',
      '30 4 * * * find /usr/local/apache/domlogs -type f -mtime +30 -delete',
    ],
  },
];

// ── certificates (/etc/pki/tls/certs/<name>.cert + .bundle, /etc/pki/tls/private/<name>.key) ──
// issuer: ca (throw-away test CA generated at build) | self
// validity: valid (−10 d … +80 d, like Let's Encrypt) | expired (2023-01-01 … 2024-01-01)

export const CERTIFICATES = [
  { name: 'alpha.example', names: ['alpha.example', 'www.alpha.example', 'mail.alpha.example', 'webmail.alpha.example'], key: 'rsa', issuer: 'ca', validity: 'valid', account: 'acct1', autossl: 'on' },
  { name: 'beta.example', names: ['beta.example', 'www.beta.example'], key: 'rsa', issuer: 'ca', validity: 'expired', account: 'acct1', autossl: 'on' },
  { name: 'app.alpha.example', names: ['app.alpha.example', 'www.app.alpha.example'], key: 'ec', issuer: 'ca', validity: 'valid', account: 'acct1', autossl: 'on' },
  { name: 'gamma.test', names: ['gamma.test'], key: 'rsa', issuer: 'self', validity: 'valid', account: 'acct2', autossl: 'off' },
  { name: 'cloud.gamma.test', names: ['cloud.gamma.test', 'www.cloud.gamma.test'], key: 'rsa', issuer: 'ca', validity: 'valid', account: 'acct2', autossl: 'on' },
  { name: 'epsilon.example', names: ['epsilon.example', 'www.epsilon.example'], key: 'rsa', issuer: 'ca', validity: 'valid', account: 'acct3', autossl: 'on' },
];

// ── systemd units outside CWP (/etc/systemd/system/*.service, files only: no systemd in the container) ──

export const SYSTEMD_UNITS = [
  { name: 'appone.service', kind: 'node', user: 'svcnode', workingDirectory: '/home/acct2/node/AppOne', execStart: '/usr/bin/node main.js',
    environment: ['NODE_ENV=production', 'PORT=3101', 'SECRET=fake-appone-secret-must-be-redacted'] },
  { name: 'apptwo.service', kind: 'node', user: 'svcnode', workingDirectory: '/home/acct2/node/AppTwo', execStart: '/usr/bin/node main.js',
    environment: ['PORT=3102', 'API_TOKEN=fake-apptwo-token-must-be-redacted'] },
  { name: 'acct1-api.service', kind: 'node', user: 'acct1', workingDirectory: '/home/acct1/api', execStart: '/usr/bin/node server.js',
    environment: ['PORT=3001'] },
  { name: 'tgbot.service', kind: 'python', user: 'svcnode', workingDirectory: '/home/acct5/scripts/bot', execStart: '/usr/bin/python3.9 bot.py',
    environment: ['BOT_TOKEN=fake-bot-token-must-be-redacted'] },
  { name: 'monitor-agent.service', kind: 'other', user: 'root', workingDirectory: '/opt/monitor-agent', execStart: '/opt/monitor-agent/agent --config /etc/monitor-agent.conf',
    environment: [] },
];

// ── CWP vhost templates (/usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/<server>/) ──

export const VHOST_TEMPLATES = {
  /** Stock CWP templates. */
  stock: { nginx: ['default', 'php-fpm'], apache: ['default', 'all_methods'], varnish: ['default'] },
  /** Custom templates (CWP-MAP §1: backbone, ws_proxy_agent, proxy_websocket, one named after a domain). */
  custom: { nginx: ['backbone', 'ws_proxy_agent', 'proxy_websocket', 'epsilon_example'] },
};
