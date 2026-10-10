// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — SQL loaded into MariaDB 10.3 at image build (build/seed.sh), in
// order: system databases (+ schema dumps of the source, seed/schemas/), client
// users + grants (BEFORE the client databases: DEFINERs, CWP-MAP §7), client
// databases, root_cwp / postfix rows, root password last.
// ─────────────────────────────────────────────────────────────────────────────

/** SQL string literal (backslash + quote escaped: the server runs without NO_BACKSLASH_ESCAPES). */
export function q(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Identifier quoted with backticks, as written by CWP (backslashes kept literally: `acct1\_%`). */
function ident(name) {
  if (name.includes('`')) throw new Error(`backtick in identifier ${name}`);
  return `\`${name}\``;
}

export function systemDatabasesSql(ds) {
  return `${ds.SYSTEM_DATABASES.map((d) => `CREATE DATABASE IF NOT EXISTS ${ident(d)};`).join('\n')}\n`;
}

export function rootCwpDataSql(ds) {
  const S = ds.SERVER;
  const out = ['USE root_cwp;'];
  for (const p of ds.PACKAGES) {
    out.push(`INSERT INTO packages (id, package_name, disk_quota, bandwidth, ftp_accounts, email_accounts, email_lists, \`databases\`, sub_domains, parked_domains, addons_domains, hourly_emails, reseller, accounts, cgroups, nproc, apache_nproc, inode, nofile) VALUES (${[
      p.id, q(p.name), q(p.disk_quota), q(p.bandwidth), q(p.ftp_accounts), q(p.email_accounts), q(p.email_lists), q(p.databases),
      q(p.sub_domains), q(p.parked_domains), q(p.addons_domains), q(p.hourly_emails), q(p.reseller), q(p.accounts), q(p.cgroups),
      q(p.nproc), q(p.apache_nproc), q(p.inode), q(p.nofile),
    ].join(', ')});`);
  }
  for (const a of ds.ACCOUNTS) {
    out.push(`INSERT INTO \`user\` (id, username, domain, ip_address, email, setup_date, package, backup, reseller, last_access, bandwidth, mail_disk, mysql_disk) VALUES (${[
      a.id, q(a.username), q(a.mainDomain), q(S.publicIp), q(a.email), q(a.setupDate), q(a.package), "'off'", q(a.reseller),
      "'2000-01-01 00:00:00'", q(a.bandwidth), 0, 0,
    ].join(', ')});`);
  }
  let domainId = 0;
  let subId = 0;
  for (const d of ds.DOMAINS) {
    if (d.kind === 'addon' || d.kind === 'parked') {
      domainId += 1;
      out.push(`INSERT INTO domains (id, domain, \`user\`, path, setup_time) VALUES (${domainId}, ${q(d.fqdn)}, ${q(d.account)}, ${q(d.path)}, ${q(d.setupTime)});`);
    } else if (d.kind === 'subdomain') {
      subId += 1;
      out.push(`INSERT INTO subdomains (id, subdomain, domain, \`user\`, path, setup_time) VALUES (${subId}, ${q(d.sub)}, ${q(d.parent)}, ${q(d.account)}, ${q(d.path)}, ${q(d.setupTime)});`);
    }
  }
  const [ns1, ns2] = S.nameservers;
  out.push(`INSERT INTO nameserver (id, ns1_name, ns1_ip, ns2_name, ns2_ip) VALUES (1, ${q(ns1.name)}, ${q(ns1.ip)}, ${q(ns2.name)}, ${q(ns2.ip)});`);
  out.push(`INSERT INTO settings (id, login_type, ssh_port, root_name, root_email, apache_port, homedir, mysql_pwd, apache_vhost_tpl, apache_sub_vhost_tpl, named_tpl, dns_zone_tpl, shared_ip) VALUES (1, 'cwp', '22', 'root', ${q(`admin@${S.serverDomain}`)}, ${q(String(S.apachePort))}, '/home', '', '', '', '', ${q('$TTL 14400\n@ 86400 IN SOA %nameserver%. %rpemail%. ( %serial% 3600 7200 1209600 86400 )\n@ 86400 IN NS %nameserver%.\n@ IN A %ip%\n')}, ${q(S.publicIp)});`);
  out.push("INSERT INTO backups (id, backup_enable, backup_location, backup_daily, backup_weekly, backup_monthly, backup_mysql, backup_vmail, backup_all) VALUES (1, 'off', '/backup', 'off', 'on', 'off', 'on', 'on', 'off');");
  out.push("INSERT INTO notifications (`user`, shortjob, description, link, readed, completed, `date`) VALUES ('root', 'autossl', 'AutoSSL renewed', '', 'yes', 'yes', '2026-07-22 15:19:30');");
  return `${out.join('\n')}\n`;
}

export function clientDatabasesSql(ds) {
  const out = [];
  for (const db of ds.DATABASES) {
    out.push(`CREATE DATABASE ${ident(db.name)} DEFAULT CHARACTER SET ${db.charset} COLLATE ${db.collation};`);
    out.push(`USE ${ident(db.name)};`);
    // Client bytes are sent as UTF-8; hex literals keep raw bytes (latin1 double-encoding rows).
    out.push('SET NAMES utf8mb4;');
    out.push(db.sql.trim());
  }
  return `${out.join('\n')}\n`;
}

function grantSql(u, g) {
  return `GRANT ${g.privs} ON ${ident(g.db)}.* TO ${q(u.user)}@${q(u.host)};`;
}

export function usersSql(ds, crypto) {
  const S = ds.SERVER;
  const out = [
    // mysql_secure_installation equivalent: no anonymous user, root only on local hosts.
    "DELETE FROM mysql.user WHERE User = '';",
    "DELETE FROM mysql.user WHERE User = 'root' AND Host NOT IN ('localhost', '127.0.0.1', '::1');",
    "DELETE FROM mysql.db WHERE Db = 'test' OR Db = 'test\\\\_%';",
    'DROP DATABASE IF EXISTS test;',
    'FLUSH PRIVILEGES;',
    `CREATE USER 'postfix'@'localhost' IDENTIFIED BY ${q(S.mysql.postfixPassword)};`,
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `postfix`.* TO 'postfix'@'localhost';",
    `CREATE USER 'roundcube'@'localhost' IDENTIFIED BY ${q(S.mysql.roundcubePassword)};`,
    "GRANT ALL PRIVILEGES ON `roundcube`.* TO 'roundcube'@'localhost';",
  ];
  for (const u of ds.DB_USERS) {
    if (u.auth === 'plugin') {
      out.push(`CREATE USER ${q(u.user)}@${q(u.host)} IDENTIFIED VIA mysql_native_password USING ${q(crypto.mysqlNative(u.password))};`);
    } else {
      out.push(`CREATE USER ${q(u.user)}@${q(u.host)} IDENTIFIED BY ${q(u.password)};`);
    }
    for (const g of u.grants) out.push(grantSql(u, g));
  }
  out.push('FLUSH PRIVILEGES;');
  return `${out.join('\n')}\n`;
}

export function rootPasswordSql(ds) {
  // MariaDB 10.3: mysql.user is still a table (whatever root rows mysql_install_db created).
  return `UPDATE mysql.user SET Password = PASSWORD(${q(ds.SERVER.mysql.rootPassword)}) WHERE User = 'root';
FLUSH PRIVILEGES;
`;
}
