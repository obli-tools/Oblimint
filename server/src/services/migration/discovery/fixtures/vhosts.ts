// ─────────────────────────────────────────────────────────────────────────────
// Vhost generators reproducing the EXACT shape of the CWP files
// (docs/cwp/vhost-nginx-sample.anon.conf, vhost-apache-sample.anon.conf):
// nested static location carrying `root`, proxy_pass to the local Apache,
// webmail. / mail. / cpanel. sub-servers, `}#####SSL` glued after a block.
// Test fixtures only.
// ─────────────────────────────────────────────────────────────────────────────

export const SRC_IP = '203.0.113.10';

const STATIC_EXT = '3gp|gif|jpg|jpeg|png|ico|wmv|avi|asf|asx|mpg|mpeg|mp4|pls|mp3|mid|wav|swf|flv|html|htm|txt|js|css|exe|zip|tar|rar|gz|tgz|bz2|uha|7z|doc|docx|xls|xlsx|pdf|iso|woff|ttf|svg|eot|sh|webp';

function tail(user: string): string {
  return `
	location ~ /\\.ht    {deny all;}
	location ~ /\\.svn/  {deny all;}
	location ~ /\\.git/  {deny all;}

	disable_symlinks if_not_owner from=/home/${user}/public_html;

	location /.well-known/acme-challenge {
		default_type "text/plain";
		alias /usr/local/apache/autossl_tmp/.well-known/acme-challenge;
	}
}`;
}

function listen(ssl: boolean): string {
  return ssl ? `listen ${SRC_IP}:443 ssl ;` : `listen ${SRC_IP}:80;`;
}

function certLines(fqdn: string, ssl: boolean): string {
  return ssl ? `
	ssl_certificate      /etc/pki/tls/certs/${fqdn}.bundle;
	ssl_certificate_key  /etc/pki/tls/private/${fqdn}.key;
	ssl_protocols TLSv1.2;` : '';
}

function serviceServers(fqdn: string, user: string, ssl: boolean): string {
  return ['webmail', 'mail', 'cpanel'].map((p) => `

server {
	${listen(ssl)}
	server_name ${p}.${fqdn};
	${certLines(fqdn, ssl)}
	location / {
		proxy_pass  ${p === 'cpanel' ? 'https://127.0.0.1:2083' : 'http://127.0.0.1:2095'};
		include proxy.inc;
	}
${tail(user)}`).join('');
}

/** nginx → Apache (:8181 / :8443) or Varnish (:82), static files served from root. */
export function nginxSite(fqdn: string, user: string, root: string, opts: { ssl?: boolean; backendPort?: number; www?: boolean } = {}): string {
  const block = (ssl: boolean) => {
    const port = opts.backendPort ?? (ssl ? 8443 : 8181);
    const scheme = !opts.backendPort && ssl ? 'https' : 'http';
    return `server {
	${listen(ssl)}
	server_name ${fqdn}${opts.www === false ? '' : `  www.${fqdn}`};

	access_log /usr/local/apache/domlogs/${fqdn}.bytes bytes;
	error_log /usr/local/apache/domlogs/${fqdn}.error.log error;
	${certLines(fqdn, ssl)}
	location / {
		location ~.*\\.(${STATIC_EXT})$ {
			root ${root};
			expires max;
			try_files $uri $uri/ @backend;
		}

		error_page 405 = @backend;
		add_header X-Cache "HIT from Backend";
		proxy_pass ${scheme}://${SRC_IP}:${port};
		include proxy.inc;
	}

	location @backend {
		internal;
		proxy_pass ${scheme}://${SRC_IP}:${port};
		include proxy.inc;
	}

	location ~ .*\\.(php|jsp|cgi|pl|py)?$ {
		proxy_pass ${scheme}://${SRC_IP}:${port};
		include proxy.inc;
	}
${tail(user)}${serviceServers(fqdn, user, ssl)}`;
  };
  return opts.ssl ? `${block(false)}#####SSL\n${block(true)}` : block(false);
}

/** nginx reverse proxy to an arbitrary target (CWP proxy template, optional websocket headers). */
export function nginxProxy(fqdn: string, user: string, target: string, websocket: boolean): string {
  return `server {
	${listen(false)}
	server_name ${fqdn} www.${fqdn};

	location / {
		proxy_pass ${target};
		proxy_http_version 1.1;${websocket ? `
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";` : ''}
		proxy_set_header Host $host;
		include proxy.inc;
	}
${tail(user)}${serviceServers(fqdn, user, false)}`;
}

/** nginx php-fpm template: fastcgi_pass to /opt/alt/php-fpmXX. */
export function nginxFpm(fqdn: string, user: string, root: string, digits: string): string {
  return `server {
	${listen(false)}
	server_name ${fqdn} www.${fqdn};
	root ${root};
	index index.php index.html;

	location / {
		try_files $uri $uri/ /index.php?$query_string;
	}

	location ~ \\.php$ {
		fastcgi_split_path_info ^(.+\\.php)(/.+)$;
		fastcgi_pass unix:/opt/alt/php-fpm${digits}/usr/var/sockets/${user}.sock;
		fastcgi_index index.php;
		include /etc/nginx/fastcgi_params;
	}
${tail(user)}${serviceServers(fqdn, user, false)}`;
}

export function nginxRedirect(fqdn: string, user: string, target: string): string {
  return `server {
	${listen(false)}
	server_name ${fqdn} www.${fqdn};
	return 301 ${target};
}${serviceServers(fqdn, user, false)}`;
}

/** Apache vhost (suPHP by default, FPM SetHandler when digits given). */
export function apacheSite(fqdn: string, user: string, root: string, opts: { fpm?: string; ssl?: boolean } = {}): string {
  const block = (ssl: boolean) => `<VirtualHost ${SRC_IP}:${ssl ? 8443 : 8181}>
	ServerName ${fqdn}
	ServerAlias www.${fqdn}
	ServerAdmin webmaster@${fqdn}
	DocumentRoot ${root}
	UseCanonicalName Off
	ScriptAlias /cgi-bin/ ${root}/cgi-bin/

	#CustomLog /usr/local/apache/domlogs/${fqdn}.bytes bytes
	ErrorLog /usr/local/apache/domlogs/${fqdn}.error.log

	<IfModule mod_setenvif.c>
		SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on
	</IfModule>

	<IfModule mod_suexec.c>
		SuexecUserGroup ${user} ${user}
	</IfModule>
${opts.fpm ? `
	<FilesMatch \\.php$>
		SetHandler "proxy:unix:/opt/alt/php-fpm${opts.fpm}/usr/var/sockets/${user}.sock|fcgi://localhost"
	</FilesMatch>
` : `
	<IfModule mod_suphp.c>
		suPHP_UserGroup ${user} ${user}
		suPHP_ConfigPath /home/${user}
	</IfModule>
`}
	<Directory "${root}">
		Options -Indexes -FollowSymLinks +SymLinksIfOwnerMatch
		AllowOverride All Options=ExecCGI,Includes,IncludesNOEXEC,Indexes,MultiViews,SymLinksIfOwnerMatch
	</Directory>

</VirtualHost>

<VirtualHost ${SRC_IP}:${ssl ? 8443 : 8181}>
	ServerName webmail.${fqdn}

	<IfModule mod_proxy.c>
		ProxyRequests Off
		ProxyPass / http://127.0.0.1:2095/
		ProxyPassReverse / http://127.0.0.1:2095/
	</IfModule>

</VirtualHost>`;
  return opts.ssl ? `${block(false)}#####SSL\n${block(true)}` : block(false);
}
