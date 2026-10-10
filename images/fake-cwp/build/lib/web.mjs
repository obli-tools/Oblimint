// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — homes, docroots, vhosts (nginx / Apache / Varnish), per-domain
// JSON, CWP templates and configuration, PHP layout (suPHP map, FPM pools,
// stub binaries). Formats: docs/cwp/vhost-*-sample.anon.conf, CWP-MAP §1, §4–§6.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import {
  CLEANUP_PHP, GIT_FILES, LARAVEL_FILES, LEGACY_MYSQL_PHP, SITE_CSS, TINY_JPEG, WP_CRON_PHP, WP_VERSION_PHP,
  BOT_PY, REQUIREMENTS_TXT, handlerHtaccess, nodePackageJson, nodeServer, phpPage, staticPage, wpConfig, wpHtaccess, wpIndex,
} from './content.mjs';

const posix = path.posix;

const NGINX_VHOSTS = '/etc/nginx/conf.d/vhosts';
const APACHE_VHOSTS = '/usr/local/apache/conf.d/vhosts';
const VARNISH_VHOSTS = '/etc/varnish/conf.d/vhosts';
const TEMPLATES = '/usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts';
const CWP_CONF = '/usr/local/cwp/.conf';

const PHP_FULL = { 56: '5.6.40', 72: '7.2.34', 73: '7.3.33', 74: '7.4.33', 81: '8.1.32', 83: '8.3.21' };

/** Domain rows that carry a vhost (the duplicated sub-domain row has none). */
export function webDomains(ds) {
  return ds.DOMAINS.filter((d) => d.web);
}

function accountOf(ds, username) {
  const a = ds.ACCOUNTS.find((x) => x.username === username);
  if (!a) throw new Error(`unknown account ${username}`);
  return a;
}

function homeOf(username) {
  return `/home/${username}`;
}

// ── homes and docroots ───────────────────────────────────────────────────────

export function renderHomes(ds, plan, crypto) {
  for (const acct of ds.ACCOUNTS) {
    const u = acct.username;
    const home = homeOf(u);
    const own = { owner: u, group: u };
    plan.dir(home, { ...own, mode: 0o711 });
    plan.dir(`${home}/public_html`, { owner: u, group: 'nobody', mode: 0o750 });
    plan.dir(`${home}/tmp`, { ...own, mode: 0o755 });
    plan.dir(`${home}/tmp/session`, { ...own, mode: 0o700 });
    plan.dir(`${home}/.conf`, { ...own, mode: 0o755 });
    plan.dir(`${home}/.conf/webservers`, { ...own, mode: 0o755 });
    plan.file(`${home}/.conf/cwp.ini`, `[user]\nlanguage=fr\ntheme=default\n`, own);
    plan.dir(`${home}/backupcwp`, { ...own, mode: 0o755 });
    plan.dir(`${home}/cwp_stats`, { ...own, mode: 0o755 });
    plan.dir(`${home}/cwp_stats/goaccess`, { ...own, mode: 0o755 });
    plan.file(`${home}/cwp_stats/goaccess/index.html`, '<html><body>GoAccess report placeholder (fake-cwp)</body></html>\n', own);
    plan.dir(`${home}/.trash`, { ...own, mode: 0o700 });
    plan.dir(`${home}/.pki`, { ...own, mode: 0o700 });
    if (['acct1', 'acct2'].includes(u)) {
      // Empty UI markers of CWP (CWP-MAP §2): no content.
      plan.dir(`${home}/.conf/reseller`, { ...own, mode: 0o755 });
      plan.file(`${home}/.conf/reseller/${acct.mainDomain}`, '', own);
    }
    if (acct.authorizedKeys > 0) {
      plan.dir(`${home}/.ssh`, { ...own, mode: 0o700 });
      const keys = Array.from({ length: acct.authorizedKeys }, (_, i) => crypto.sshPublicKey(`${u}-key${i + 1}@fake-cwp.test`));
      plan.file(`${home}/.ssh/authorized_keys`, `${keys.join('\n')}\n`, { ...own, mode: 0o600 });
    }
    for (const rel of acct.phpIni) {
      if (u === 'acct5') continue; // acct5's php.ini is a symlink trap (renderTraps)
      const ini = rel.endsWith('.user.ini')
        ? 'memory_limit = 256M\nupload_max_filesize = 64M\n'
        : '; suPHP_ConfigPath = home: this php.ini applies to every suPHP site of the account (fake-cwp)\nmemory_limit = 512M\nmax_execution_time = 120\ndate.timezone = Europe/Paris\n';
      plan.file(`${home}/${rel}`, ini, own);
    }
  }

  // Outside CWP: technical / admin users (CWP-MAP §4 (a)).
  for (const lu of ds.LINUX_USERS) {
    if (!lu.createHome) continue;
    const own = { owner: lu.username, group: lu.username };
    plan.dir(lu.home, { ...own, mode: 0o700 });
    plan.file(`${lu.home}/.bashrc`, '# .bashrc (fake-cwp)\n[ -f /etc/bashrc ] && . /etc/bashrc\n', own);
    if (lu.authorizedKeys > 0) {
      plan.dir(`${lu.home}/.ssh`, { ...own, mode: 0o700 });
      const keys = Array.from({ length: lu.authorizedKeys }, (_, i) => crypto.sshPublicKey(`${lu.username}-key${i + 1}@fake-cwp.test`));
      plan.file(`${lu.home}/.ssh/authorized_keys`, `${keys.join('\n')}\n`, { ...own, mode: 0o600 });
    }
  }

  // Leftover of the CWP→CWP migration of the source (CWP-MAP §1): not an account.
  plan.dir('/home/.CWPTOCWP_20250905', { mode: 0o700 });
}

function ensureDocroot(plan, acct, docroot) {
  const home = homeOf(acct.username);
  const own = { owner: acct.username, group: acct.username };
  plan.parents(docroot, { ...own, mode: 0o755, stopAt: home });
  if (!plan.has(docroot)) plan.dir(docroot, { ...own, mode: 0o755 });
}

/** /home/<u> for a path under a home (directories above it are never re-declared), '/' otherwise. */
function homeRoot(p) {
  const m = /^\/home\/[^/]+/.exec(p);
  return m ? m[0] : '/';
}

/** Writes rel → content under base (missing directories created, owned by `own`). */
function tree(plan, base, files, own, modes = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const p = posix.join(base, rel);
    plan.parents(p, { ...own, mode: 0o755, stopAt: homeRoot(base) });
    plan.file(p, content, { ...own, mode: modes[rel] ?? 0o644 });
  }
}

export function renderDocroots(ds, plan) {
  const dbUser = (name) => ds.DB_USERS.find((u) => u.user === name && u.host === 'localhost');
  for (const d of webDomains(ds)) {
    const acct = accountOf(ds, d.account);
    const own = { owner: acct.username, group: acct.username };
    const docroot = d.web.docroot;
    const app = d.app;
    if (app?.type === 'symlink-docroot') {
      plan.symlink(docroot, app.target, own);
      continue;
    }
    ensureDocroot(plan, acct, docroot);
    const rootHandler = d.web.htaccess?.root ?? null;
    switch (app?.type) {
      case 'wordpress': {
        const user = dbUser(app.dbUser);
        tree(plan, docroot, {
          'index.php': wpIndex(),
          'wp-cron.php': WP_CRON_PHP,
          'wp-includes/version.php': WP_VERSION_PHP,
          'wp-admin/index.php': '<?php\n// wp-admin placeholder (fake-cwp)\n',
          'wp-content/themes/fakecwp/style.css': '/*\nTheme Name: fakecwp\n*/\n',
          'wp-content/uploads/2024/01/photo-1.jpg': TINY_JPEG,
          'wp-content/uploads/2024/01/photo-2.jpg': TINY_JPEG,
          '.htaccess': wpHtaccess({ handler: rootHandler }),
        }, own);
        plan.file(`${docroot}/wp-config.php`, wpConfig({ db: app.db, user: app.dbUser, password: user.password, salt: `fake-cwp-${d.fqdn}` }), { ...own, mode: 0o640 });
        if (app.legacyMysql) tree(plan, docroot, { 'legacy.php': LEGACY_MYSQL_PHP, 'tools/cleanup.php': CLEANUP_PHP }, own);
        if (d.account === 'acct1') {
          // Target of a cron redirection (cronWritesToCode).
          tree(plan, docroot, { 'logs/cron.log': '[2024-03-01 03:15:00] schedule:run done\n' }, own);
        }
        break;
      }
      case 'laravel':
        tree(plan, app.root, LARAVEL_FILES, own, { artisan: 0o755 });
        break;
      case 'node-api':
        tree(plan, docroot, { 'server.js': nodeServer('api', 3001), 'package.json': nodePackageJson('fake-api', 'server.js') }, own);
        break;
      case 'git-static':
        tree(plan, docroot, { 'index.html': staticPage(app.title), 'css/site.css': SITE_CSS, ...GIT_FILES }, own);
        break;
      case 'static':
        tree(plan, docroot, { 'index.html': staticPage(app.title), 'css/site.css': SITE_CSS }, own);
        break;
      case 'php':
        tree(plan, docroot, { 'index.php': phpPage(app.title) }, own);
        break;
      default:
        break; // proxies / parked: directory only (CWP creates it)
    }
    if (rootHandler && app?.type !== 'wordpress') tree(plan, docroot, { '.htaccess': handlerHtaccess(rootHandler) }, own);
    for (const [rel, handler] of Object.entries(d.web.htaccess?.subdirs ?? {})) {
      tree(plan, posix.join(docroot, rel), { '.htaccess': handlerHtaccess(handler), 'index.php': phpPage(`${d.fqdn}/${rel} (${handler})`) }, own);
    }
  }
}

/** Account directories that are neither docroots nor CWP internals (CWP-MAP §4, §11). */
export function renderAccountExtras(ds, plan) {
  const acct1 = { owner: 'acct1', group: 'acct1' };
  tree(plan, '/home/acct1/scripts', {
    'backup.sh': '#!/bin/sh\nset -eu\n# backup (fake-cwp, disabled cron line)\necho backup\n',
    'every-minute.sh': '#!/bin/sh\nset -eu\n# runs every minute (fake-cwp): below the minimum interval of a plan\ndate >/dev/null\n',
  }, acct1, { 'backup.sh': 0o755, 'every-minute.sh': 0o755 });

  // Node apps of acct2's home RUN BY ANOTHER LINUX USER (svcnode): files owned by another uid.
  const svc = { owner: 'svcnode', group: 'svcnode' };
  plan.dir('/home/acct2/node', { owner: 'acct2', group: 'acct2', mode: 0o755 });
  for (const [name, port] of [['AppOne', 3101], ['AppTwo', 3102]]) {
    plan.dir(`/home/acct2/node/${name}`, { ...svc, mode: 0o755 });
    tree(plan, `/home/acct2/node/${name}`, { 'main.js': nodeServer(name, port), 'package.json': nodePackageJson(name.toLowerCase(), 'main.js') }, svc);
  }

  const acct5 = { owner: 'acct5', group: 'acct5' };
  tree(plan, '/home/acct5/scripts/bot', { 'bot.py': BOT_PY, 'requirements.txt': REQUIREMENTS_TXT }, acct5, { 'bot.py': 0o755 });

  // MG10 traps: names the executor may cat under /home, pointing to /etc/shadow.
  plan.symlink('/home/acct5/public_html/.htaccess', '/etc/shadow', acct5);
  plan.symlink('/home/acct5/public_html/.htaccess-link', '/etc/shadow', acct5);
  plan.symlink('/home/acct5/php.ini', '/etc/shadow', acct5);
}

// ── vhosts ───────────────────────────────────────────────────────────────────

const NGINX_DENY = `	location ~ /\\.ht    {deny all;}
	location ~ /\\.svn/  {deny all;}
	location ~ /\\.git/  {deny all;}
	location ~ /\\.hg/   {deny all;}
	location ~ /\\.bzr/  {deny all;}`;

const NGINX_ACME = `	location /.well-known/acme-challenge {
		default_type "text/plain";
		alias /usr/local/apache/autossl_tmp/.well-known/acme-challenge;
	}

	location /.well-known/pki-validation {
		default_type "text/plain";
		alias /usr/local/apache/autossl_tmp/.well-known/acme-challenge;
	}`;

const SSL_CIPHERS = 'EECDH+ECDSA+AESGCM:EECDH+aRSA+AESGCM:EECDH+ECDSA+SHA384:EECDH+ECDSA+SHA256:EECDH+aRSA+SHA384:EECDH+aRSA+SHA256:EECDH+aRSA!RC4:EECDH:!RC4:!aNULL:!eNULL:!LOW:!3DES:!MD5:!EXP:!PSK:!SRP:!DSS';

const STATIC_EXT = '3gp|gif|jpg|jpeg|png|ico|wmv|avi|asf|asx|mpg|mpeg|mp4|pls|mp3|mid|wav|swf|flv|html|htm|txt|js|css|exe|zip|tar|rar|gz|tgz|bz2|uha|7z|doc|docx|xls|xlsx|pdf|iso|woff|ttf|svg|eot|sh|webp';

function nginxHead(ds, { names, ssl, cert, logName }) {
  const ip = ds.SERVER.publicIp;
  const listen = ssl ? `	listen ${ip}:443 ssl ;` : `	listen ${ip}:80;	`;
  const lines = [
    'server {',
    listen,
    `	server_name ${names.join('  ')};`,
    '',
    `	access_log /usr/local/apache/domlogs/${logName}.bytes bytes;`,
    `	access_log /usr/local/apache/domlogs/${logName}.log combined;`,
    `	error_log /usr/local/apache/domlogs/${logName}.error.log error;`,
    '',
  ];
  if (ssl) {
    lines.push(
      `	ssl_certificate      /etc/pki/tls/certs/${cert}.bundle;`,
      `	ssl_certificate_key  /etc/pki/tls/private/${cert}.key;`,
      '	ssl_protocols TLSv1.2;',
      `	ssl_ciphers ${SSL_CIPHERS};`,
      '	ssl_prefer_server_ciphers   on;',
      '',
      '	ssl_session_cache   shared:SSL:10m;',
      '	ssl_session_timeout 60m;',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function nginxTail(fromDir) {
  return `${NGINX_DENY}\n\n	disable_symlinks if_not_owner from=${fromDir};\n\n${NGINX_ACME}\n}`;
}

/** nginx → Apache (:8181) or Varnish (:82): the sample's site server. */
function nginxBackendServer(ds, { names, ssl, cert, logName, docroot, backend, extra = '' }) {
  const hsts = ssl ? '\n		add_header Strict-Transport-Security "max-age=31536000";' : '';
  return `${nginxHead(ds, { names, ssl, cert, logName })}	location / {
		location ~.*\\.(${STATIC_EXT})$ {
			root ${docroot};
			expires max;
			try_files $uri $uri/ @backend;
		}

		error_page 405 = @backend;
		error_page 500 = @custom;
		add_header X-Cache "HIT from Backend";${hsts}
		add_header X-XSS-Protection "1; mode=block" always;
		add_header X-Content-Type-Options "nosniff" always;
		proxy_pass ${backend};
		include proxy.inc;
	}

	location @backend {
		internal;
		proxy_pass ${backend};
		include proxy.inc;
	}

	location @custom {
		internal;
		proxy_pass ${backend};
		include proxy.inc;
	}

	location ~ .*\\.(php|jsp|cgi|pl|py)?$ {
		proxy_pass ${backend};
		include proxy.inc;
	}
${extra}
${nginxTail(docroot)}`;
}

/** Template php-fpm of nginx: PHP served by nginx itself (fastcgi_pass to the account pool). */
function nginxFpmServer(ds, { names, ssl, cert, logName, docroot, user, fpm }) {
  return `${nginxHead(ds, { names, ssl, cert, logName })}	root ${docroot};
	index index.php index.html index.htm;

	location / {
		try_files $uri $uri/ /index.php?$query_string;
	}

	location ~ \\.php$ {
		fastcgi_split_path_info ^(.+\\.php)(/.+)$;
		fastcgi_pass unix:/opt/alt/php-fpm${fpm}/usr/var/sockets/${user}.sock;
		fastcgi_index index.php;
		include /etc/nginx/fastcgi_params;
		fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
		fastcgi_param PATH_INFO $fastcgi_path_info;
	}

${nginxTail(docroot)}`;
}

/** Reverse proxy to an arbitrary target (CWP "proxy" domains, custom-ip variant, websocket templates). */
function nginxProxyServer(ds, { names, ssl, cert, logName, proxy, fromDir }) {
  const ws = proxy.websocket
    ? `
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";
		proxy_read_timeout 3600s;`
    : '';
  return `${nginxHead(ds, { names, ssl, cert, logName })}	location / {
		proxy_pass ${proxy.scheme}://${proxy.host}:${proxy.port};
		include proxy.inc;${ws}
	}

${nginxTail(fromDir)}`;
}

/** webmail. / mail. / cpanel. sub-servers of a vhost (proxied to cwpsrv: NOT sites). */
function nginxServiceServers(ds, { fqdn, ssl, cert, fromDir }) {
  const out = [];
  for (const sub of ['webmail', 'mail', 'cpanel']) {
    const head = nginxHead(ds, { names: [`${sub}.${fqdn}`], ssl, cert, logName: fqdn }).replace(`listen ${ds.SERVER.publicIp}:443 ssl ;`, `listen ${ds.SERVER.publicIp}:443 ssl ;	`);
    const body = sub === 'cpanel'
      ? `	location / {
		proxy_pass  https://127.0.0.1:2083;
		include proxy.inc;
	}

	location /pma {
		proxy_pass  https://127.0.0.1:2031;
		include proxy.inc;
	}

	location /roundcube {
		proxy_pass  https://127.0.0.1:2031;
		include proxy.inc;
	}
`
      : `	location / {
		proxy_pass  http://127.0.0.1:2095;
		include proxy.inc;
	}
`;
    out.push(`${head}${body}\n${nginxTail(fromDir)}`);
  }
  return out;
}

function namesOf(d) {
  return d.web.www ? [d.fqdn, `www.${d.fqdn}`] : [d.fqdn];
}

function renderNginx(ds, d, { ssl }) {
  const acct = accountOf(ds, d.account);
  const cert = d.web.ssl;
  const logName = d.fqdn;
  const names = namesOf(d);
  const fromDir = `${homeOf(acct.username)}/public_html`;
  const ip = ds.SERVER.publicIp;
  const servers = [];
  if (d.web.serving === 'proxy') {
    servers.push(nginxProxyServer(ds, { names, ssl, cert, logName, proxy: d.web.proxy, fromDir }));
  } else if (d.web.php?.handler === 'nginx-fpm') {
    servers.push(nginxFpmServer(ds, { names, ssl, cert, logName, docroot: d.web.docroot, user: acct.username, fpm: d.web.php.fpm }));
  } else {
    const backend = d.web.varnish ? `http://${ip}:${ds.SERVER.varnishPort}` : `http://${ip}:${ds.SERVER.apachePort}`;
    const extra = d.web.template === 'epsilon_example'
      ? `
	# custom template epsilon_example (CWP-MAP §1): extra API location to a LAN service
	location /status/ {
		proxy_pass http://10.0.0.50:9000/;
		include proxy.inc;
	}
	add_header X-Template "epsilon_example";
`
      : '';
    servers.push(nginxBackendServer(ds, { names, ssl, cert, logName, docroot: d.web.docroot, backend, extra }));
  }
  if (d.web.subServers) servers.push(...nginxServiceServers(ds, { fqdn: d.fqdn, ssl, cert, fromDir }));
  return `${servers.join('\n\n')}\n`;
}

function apacheSiteVhost(ds, d, { ssl }) {
  const acct = accountOf(ds, d.account);
  const u = acct.username;
  const ip = ds.SERVER.publicIp;
  const port = ssl ? ds.SERVER.apacheSslPort : ds.SERVER.apachePort;
  const docroot = d.web.docroot;
  const alias = d.web.www ? `\n	ServerAlias www.${d.fqdn}` : '';
  const sslBlock = ssl
    ? `
	SSLEngine on
	SSLCertificateFile /etc/pki/tls/certs/${d.web.ssl}.cert
	SSLCertificateKeyFile /etc/pki/tls/private/${d.web.ssl}.key
	SSLCertificateChainFile /etc/pki/tls/certs/${d.web.ssl}.bundle
	SetEnvIf User-Agent ".*MSIE.*" nokeepalive ssl-unclean-shutdown
`
    : `
	<IfModule mod_setenvif.c>
		SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on
	</IfModule>
`;
  const fpm = d.web.php?.handler === 'php-fpm'
    ? `
	<IfModule proxy_fcgi_module>
		<FilesMatch \\.php$>
			SetHandler "proxy:unix:/opt/alt/php-fpm${d.web.php.fpm}/usr/var/sockets/${u}.sock|fcgi://localhost"
		</FilesMatch>
	</IfModule>
`
    : '';
  return `<VirtualHost ${ip}:${port}>
	ServerName ${d.fqdn}${alias}
	ServerAdmin webmaster@${d.fqdn}
	DocumentRoot ${docroot}
	UseCanonicalName Off
	ScriptAlias /cgi-bin/ ${docroot}/cgi-bin/

	#CustomLog /usr/local/apache/domlogs/${d.fqdn}.bytes bytes
	#CustomLog /usr/local/apache/domlogs/${d.fqdn}.log combined
	ErrorLog /usr/local/apache/domlogs/${d.fqdn}.error.log

	# Custom settings are loaded below this line (if any exist)
	# IncludeOptional "/usr/local/apache/conf/userdata/${u}/${d.fqdn}/*.conf"
${sslBlock}
	<IfModule mod_userdir.c>
		UserDir disabled
		UserDir enabled ${u}
	</IfModule>

	<IfModule mod_suexec.c>
		SuexecUserGroup ${u} ${u}
	</IfModule>

	<IfModule mod_suphp.c>
		suPHP_UserGroup ${u} ${u}
		suPHP_ConfigPath /home/${u}
	</IfModule>

	<IfModule mod_ruid2.c>
		RMode config
		RUidGid ${u} ${u}
	</IfModule>

	<IfModule itk.c>
		AssignUserID ${u} ${u}
	</IfModule>
${fpm}
	<Directory "${docroot}">
		Options -Indexes -FollowSymLinks +SymLinksIfOwnerMatch
		AllowOverride All Options=ExecCGI,Includes,IncludesNOEXEC,Indexes,MultiViews,SymLinksIfOwnerMatch${ssl ? '\n		SSLRequireSSL' : ''}
	</Directory>

</VirtualHost>`;
}

function apacheServiceVhosts(ds, d, { ssl }) {
  const ip = ds.SERVER.publicIp;
  const port = ssl ? ds.SERVER.apacheSslPort : ds.SERVER.apachePort;
  const sslBlock = ssl
    ? `
	SSLEngine on
	SSLCertificateFile /etc/pki/tls/certs/${d.web.ssl}.cert
	SSLCertificateKeyFile /etc/pki/tls/private/${d.web.ssl}.key
	SSLCertificateChainFile /etc/pki/tls/certs/${d.web.ssl}.bundle
	SetEnvIf User-Agent ".*MSIE.*" nokeepalive ssl-unclean-shutdown
`
    : '';
  const out = [];
  for (const sub of ['webmail', 'mail']) {
    out.push(`<VirtualHost ${ip}:${port}>
	ServerName ${sub}.${d.fqdn}
${sslBlock}
	<IfModule mod_proxy.c>
		ProxyRequests Off
		ProxyPreserveHost On
		ProxyVia Full
		ProxyPass / http://127.0.0.1:2095/
		ProxyPassReverse / http://127.0.0.1:2095/

		<Proxy *>
			AllowOverride All
		</Proxy>
	</IfModule>

	<IfModule mod_security2.c>
		SecRuleEngine Off
	</IfModule>

</VirtualHost>`);
  }
  out.push(`<VirtualHost ${ip}:${port}>
	ServerName cpanel.${d.fqdn}
${sslBlock}
	<IfModule mod_proxy.c>
		SSLProxyEngine on
		SSLProxyVerify none
		SSLProxyCheckPeerCN off
		SSLProxyCheckPeerName off
		SSLProxyCheckPeerExpire off
		ProxyRequests Off
		ProxyPreserveHost On
		ProxyVia Full

		RewriteEngine on

		RewriteRule ^/roundcube$ /roundcube/ [R]
		ProxyPass /roundcube/ https://127.0.0.1:2031/roundcube/
		ProxyPassReverse /roundcube https://127.0.0.1:2031/roundcube/

		RewriteRule ^/pma$ /pma/ [R]
		ProxyPass /pma/ https://127.0.0.1:2031/pma/
		ProxyPassReverse /pma https://127.0.0.1:2031/pma/

		ProxyPass / https://127.0.0.1:2083/
		ProxyPassReverse / https://127.0.0.1:2083/

		<Proxy *>
			AllowOverride All
		</Proxy>
	</IfModule>

	<IfModule mod_security2.c>
		SecRuleEngine Off
	</IfModule>

</VirtualHost>`);
  return out;
}

function renderApache(ds, d, { ssl }) {
  const parts = [apacheSiteVhost(ds, d, { ssl })];
  if (d.web.subServers) parts.push(...apacheServiceVhosts(ds, d, { ssl }));
  return `${parts.join('\n\n')}\n`;
}

function varnishVhost(d) {
  const id = d.fqdn.replace(/[^a-z0-9]/g, '_');
  return `# Varnish vhost (CWP): custom backend of ${d.fqdn}
backend ${id} {
    .host = "${d.web.varnish.backendHost}";
    .port = "${d.web.varnish.backendPort}";
}

sub vcl_recv {
    if (req.http.host ~ "^(www\\.)?${d.fqdn.replace(/\./g, '\\.')}$") {
        set req.backend_hint = ${id};
    }
}
`;
}

/** Vhost files of every domain row (paths returned for the inventory facts). */
export function renderVhosts(ds, plan) {
  plan.dir(NGINX_VHOSTS);
  plan.dir('/usr/local/apache');
  plan.dir('/usr/local/apache/conf.d');
  plan.dir(APACHE_VHOSTS);
  plan.dir('/etc/varnish/conf.d');
  plan.dir(VARNISH_VHOSTS);
  const files = {};
  for (const d of webDomains(ds)) {
    const suffix = d.web.serving === 'disabled' ? '.disabled' : '';
    const list = [];
    const write = (p, content) => { plan.file(p, content); list.push(p); };
    write(`${NGINX_VHOSTS}/${d.fqdn}.conf${suffix}`, renderNginx(ds, d, { ssl: false }));
    if (d.web.ssl) write(`${NGINX_VHOSTS}/${d.fqdn}.ssl.conf${suffix}`, renderNginx(ds, d, { ssl: true }));
    if (d.web.apache) {
      write(`${APACHE_VHOSTS}/${d.fqdn}.conf${suffix}`, renderApache(ds, d, { ssl: false }));
      if (d.web.ssl) write(`${APACHE_VHOSTS}/${d.fqdn}.ssl.conf${suffix}`, renderApache(ds, d, { ssl: true }));
    }
    if (d.web.varnish) write(`${VARNISH_VHOSTS}/${d.fqdn}.conf`, varnishVhost(d));
    files[d.fqdn] = list;
  }
  return files;
}

// ── per-domain JSON, WordPress list, CWP templates ───────────────────────────

export function renderAccountConf(ds, plan) {
  for (const d of webDomains(ds)) {
    if (!d.web.json) continue;
    const own = { owner: d.account, group: d.account };
    plan.file(`/home/${d.account}/.conf/webservers/${d.fqdn}.conf`, `${JSON.stringify(d.web.json)}\n`, own);
  }
  for (const acct of ds.ACCOUNTS) {
    const wps = webDomains(ds).filter((d) => d.account === acct.username && d.app?.type === 'wordpress' && d.app.addonsWp);
    if (wps.length === 0) continue;
    const list = wps.map((d) => ({
      domain: d.fqdn, path: `${d.web.docroot}/`, url: `http://${d.fqdn}/`, wpbd: d.app.db, wpuserdb: d.app.dbUser,
      db_result: { result: 'success' }, version: null, lang: 'fr', installed_at: '2023-02-06 20:58:24',
      footprint: 'f00dcafef00dcafef00dcafef00dcafe',
    }));
    plan.file(`/home/${acct.username}/.conf/.addons_wp`, JSON.stringify(list), { owner: acct.username, group: acct.username });
  }
}

function templateBody(server, name) {
  const kind = name.includes('websocket') || name.includes('proxy') ? 'proxy' : 'site';
  if (server === 'nginx' && kind === 'proxy') {
    return `server {
	listen %ip%:%nginx_port%;
	server_name %domain% www.%domain%;
	location / {
		proxy_pass http://%custom_ip%:%custom_port%;
		include proxy.inc;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";
	}
}
# template ${name} (fake-cwp)
`;
  }
  if (server === 'nginx') {
    return `server {
	listen %ip%:%nginx_port%;
	server_name %domain% www.%domain%;
	root %docroot%;
	location / {
		proxy_pass http://%ip%:%backend_port%;
		include proxy.inc;
	}
}
# template ${name} (fake-cwp)
`;
  }
  if (server === 'apache') {
    return `<VirtualHost %ip%:%backend_port%>
	ServerName %domain%
	ServerAlias www.%domain%
	DocumentRoot %docroot%
</VirtualHost>
# template ${name} (fake-cwp)
`;
  }
  return `# varnish template ${name} (fake-cwp)\nsub vcl_recv { }\n`;
}

export function renderTemplates(ds, plan) {
  const all = { nginx: [...ds.VHOST_TEMPLATES.stock.nginx, ...ds.VHOST_TEMPLATES.custom.nginx], apache: ds.VHOST_TEMPLATES.stock.apache, varnish: ds.VHOST_TEMPLATES.stock.varnish };
  for (const [server, names] of Object.entries(all)) {
    for (const name of names) {
      plan.file(`${TEMPLATES}/${server}/${name}.tpl`, templateBody(server, name));
      if (server !== 'varnish') plan.file(`${TEMPLATES}/${server}/${name}.stpl`, templateBody(server, name).replace('%nginx_port%', '%nginx_ssl_port%').replace('%backend_port%', '%backend_ssl_port%'));
    }
  }
}

// ── CWP configuration, suspension markers, domlogs ───────────────────────────

export function renderCwpConf(ds, plan) {
  const S = ds.SERVER;
  plan.dir(CWP_CONF, { mode: 0o700 });
  const conf = (name, content) => plan.file(`${CWP_CONF}/${name}`, content, { mode: 0o600 });
  conf('web_servers.conf', `${JSON.stringify({ webserver_setup: S.webserverSetup, apache: 'on', nginx: 'on', varnish: 'on', 'php-fpm': 'on' })}\n`);
  const ssl = {};
  for (const c of ds.CERTIFICATES) {
    ssl[c.name] = {
      user: c.account, install_date: '2026-07-22 15:19:30', expiry_date: c.validity === 'expired' ? '2024-01-01 00:00:00' : '2026-12-20 15:19:30',
      san: c.names.filter((n) => n !== c.name), autossl: c.autossl,
    };
  }
  conf('vhosts-ssl.json', `${JSON.stringify(ssl)}\n`);
  conf('config_ssl.json', `${JSON.stringify({ autossl: 'on', autossl_san: ['mail', 'webmail', 'ftp', 'cpanel'] })}\n`);
  conf('mysql_user_prefix.conf', `${S.extraDbPrefixes.join('\n')}\n`);
  conf('.cwp_pro.conf', S.cwpPro ? '1' : '0');
  conf('backup_manager.conf', 'backup_enable=off\nbackup_location=/backup\n');
  conf('cwp_api_key.conf', 'fake-cwp-must-never-be-read\n');
  plan.dir(`${CWP_CONF}/php_conf`, { mode: 0o700 });
  conf('php_conf/php83.ini', 'memory_limit = 256M\n');
  plan.dir(`${CWP_CONF}/php-fpm_conf`, { mode: 0o700 });
  for (const v of S.phpFpm) conf(`php-fpm_conf/php${v}.conf`, `pm = ondemand\npm.max_children = 4\n`);
  plan.dir(`${CWP_CONF}/mysql_manager`, { mode: 0o700 });
  conf('mysql_manager/default_settings.json', `${JSON.stringify({ remote_access: 'off', password: 'fake-cwp-must-never-be-read' })}\n`);

  plan.file('/usr/local/cwpsrv/htdocs/resources/admin/include/version.php', `<?php\n$webpanel_version = "${S.cwpVersion}";\n?>\n`);

  plan.dir('/usr/local/cwp/users');
  plan.dir('/usr/local/cwp/users/suspended');
  plan.dir('/usr/local/apache/conf.d/suspended_accounts');
  for (const a of ds.ACCOUNTS.filter((x) => x.suspended)) {
    plan.dir(`/usr/local/cwp/users/suspended/${a.username}`);
    plan.file(`/usr/local/apache/conf.d/suspended_accounts/${a.username}.conf`,
      `# Account ${a.username} suspended by CWP\n<Directory "/home/${a.username}">\n	Require all denied\n</Directory>\n`);
  }

  plan.dir('/usr/local/apache/domlogs');
  for (const d of webDomains(ds).filter((x) => x.web.serving !== 'disabled')) {
    plan.file(`/usr/local/apache/domlogs/${d.fqdn}.log`, `192.0.2.99 - - [01/Mar/2024:12:00:00 +0100] "GET / HTTP/1.1" 200 512 "-" "curl/8.0"\n`);
    plan.file(`/usr/local/apache/domlogs/${d.fqdn}.bytes`, '1709290800 512 .\n');
    plan.file(`/usr/local/apache/domlogs/${d.fqdn}.error.log`, '');
  }
}

// ── PHP: suPHP map, alt binaries (stubs), FPM pools ──────────────────────────

function phpStub(version, kind) {
  return `#!/bin/sh
# fake-cwp (TEST ONLY): stub of ${kind} ${version} — there is no PHP interpreter in this image.
case "\${1:-}" in
	-v|--version) echo "PHP ${version} (${kind === 'php-cgi' ? 'cgi-fcgi' : 'cli'}) (built: Jan  1 2025 00:00:00) ( NTS )"; exit 0 ;;
esac
echo "fake-cwp: ${kind} ${version} is a stub" >&2
exit 1
`;
}

export function renderPhp(ds, plan) {
  const S = ds.SERVER;
  const bin = { mode: 0o755 };
  plan.file('/usr/local/bin/php', phpStub(S.phpDefaultFull, 'php'), bin);
  plan.file('/usr/local/bin/php-cgi', phpStub(S.phpDefaultFull, 'php-cgi'), bin);
  plan.file('/usr/local/cwp/php71/bin/php', phpStub('7.1.33', 'php'), bin);

  const handlers = [
    '[global]', 'logfile=/usr/local/apache/logs/suphp.log', 'loglevel=info', 'webserver_user=nobody', 'docroot=/', 'allow_file_group_writeable=true',
    'allow_file_others_writeable=false', 'allow_directory_group_writeable=true', 'allow_directory_others_writeable=false',
    'check_vhost_docroot=false', 'errors_to_browser=false', 'env_path=/bin:/usr/bin', 'umask=0022', 'min_uid=100', 'min_gid=99', '',
    '[handlers]', ';Handler for php-scripts', 'application/x-httpd-php="php:/usr/local/bin/php-cgi"',
  ];
  for (const v of S.phpAlt) handlers.push(`x-httpd-php${v}="php:/opt/alt/php${v}/usr/bin/php-cgi"`);
  for (const v of S.phpAlt) handlers.push(`application/x-httpd-php${v}="php:/opt/alt/php${v}/usr/bin/php-cgi"`);
  handlers.push('', ';Handler for CGI-scripts', 'x-suphp-cgi="execute:!self"', '');
  plan.file('/usr/local/etc/suphp.conf', handlers.join('\n'));

  for (const v of S.phpAlt) {
    plan.file(`/opt/alt/php${v}/usr/bin/php`, phpStub(PHP_FULL[v], 'php'), bin);
    plan.file(`/opt/alt/php${v}/usr/bin/php-cgi`, phpStub(PHP_FULL[v], 'php-cgi'), bin);
    plan.file(`/opt/alt/php${v}/etc/php.ini`, `; php.ini of /opt/alt/php${v} (fake-cwp)\nmemory_limit = 256M\n`);
  }
  const poolUsers = [...ds.ACCOUNTS.filter((a) => a.fpmPools).map((a) => a.username), 'nobody'];
  for (const v of S.phpFpm) {
    const base = `/opt/alt/php-fpm${v}/usr`;
    plan.file(`${base}/sbin/php-fpm`, phpStub(PHP_FULL[v], 'php-fpm'), bin);
    plan.file(`${base}/php/php.ini`, `; php.ini of php-fpm${v} (fake-cwp)\nmemory_limit = 256M\n`);
    plan.parents(`${base}/var/sockets/x`);
    plan.dir(`${base}/var/sockets`);
    plan.parents(`${base}/etc/php-fpm.d/users/x`);
    for (const u of poolUsers) {
      const home = u === 'nobody' ? '/tmp' : `/home/${u}/tmp`;
      plan.file(`${base}/etc/php-fpm.d/users/${u}.conf`, `[${u}]
listen = /opt/alt/php-fpm${v}/usr/var/sockets/${u}.sock
listen.owner = ${u}
listen.group = nobody
listen.mode = 0640
user = ${u}
group = ${u}
pm = ondemand
pm.max_children = 4
pm.max_requests = 4000
pm.process_idle_timeout = 15s
env[TMP] = ${home}
env[TMPDIR] = ${home}
env[TEMP] = ${home}
`);
    }
  }
}

/** Facts for the expected inventory: vhost files per fqdn. */
export const VHOST_DIRS = { NGINX_VHOSTS, APACHE_VHOSTS, VARNISH_VHOSTS, TEMPLATES };
