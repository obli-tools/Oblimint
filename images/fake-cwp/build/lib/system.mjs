// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — Linux users, Pure-FTPd virtual users, crontabs, certificates,
// systemd units outside CWP (CWP-MAP §4, §10, §11).
// ─────────────────────────────────────────────────────────────────────────────

export function renderUsers(ds, plan) {
  // CWP's mail owner (CWP-MAP §8: uid 101, group mail = 12).
  plan.user({ name: 'vmail', uid: 101, group: 'mail', home: '/var/vmail', shell: '/sbin/nologin', system: true, password: null });
  for (const a of ds.ACCOUNTS) {
    plan.group(a.username, a.uid);
    plan.user({ name: a.username, uid: a.uid, group: a.username, home: `/home/${a.username}`, shell: a.shell, password: a.linuxPassword });
  }
  for (const lu of ds.LINUX_USERS) {
    plan.group(lu.username, lu.uid);
    plan.user({ name: lu.username, uid: lu.uid, group: lu.username, home: lu.home, shell: lu.shell, password: lu.linuxPassword });
  }
}

/** /etc/pure-ftpd/pureftpd.passwd: login:hash:uid:gid::dir/./ + 12 empty fields (18 fields, docs/cwp/samples.anon.md). */
export function renderFtp(ds, plan, crypto) {
  const lines = ds.FTP_USERS.map((f) => {
    const acct = ds.ACCOUNTS.find((a) => a.username === f.account);
    const hash = f.scheme === 'bcrypt' ? crypto.bcrypt(f.password, f.login) : crypto.md5crypt(f.password, f.login);
    return `${f.login}:${hash}:${acct.uid}:${acct.uid}::${f.dir}/./${':'.repeat(12)}`;
  });
  plan.dir('/etc/pure-ftpd');
  plan.file('/etc/pure-ftpd/pureftpd.passwd', `${lines.join('\n')}\n`, { mode: 0o600 });
}

export function renderCron(ds, plan) {
  plan.dir('/var/spool/cron', { mode: 0o700 });
  for (const tab of ds.CRONTABS) {
    const content = `${tab.lines.join('\n')}\n`;
    plan.file(`/var/spool/cron/${tab.owner}`, content, { owner: tab.fileOwner, group: tab.fileOwner, mode: 0o600 });
    if (tab.copyInHome) plan.file(`/home/${tab.owner}/cron`, content, { owner: tab.owner, group: tab.owner, mode: 0o644 });
  }
}

export function renderCertificates(ds, plan, crypto) {
  plan.dir('/etc/pki/tls/certs');
  plan.dir('/etc/pki/tls/private');
  for (const c of ds.CERTIFICATES) {
    const { certPem, chainPem, keyPem } = crypto.certificate(c);
    plan.file(`/etc/pki/tls/certs/${c.name}.cert`, certPem);
    plan.file(`/etc/pki/tls/certs/${c.name}.bundle`, `${certPem}${chainPem}`);
    plan.file(`/etc/pki/tls/private/${c.name}.key`, keyPem, { mode: 0o600 });
  }
  // Server certificate (Postfix / Dovecot / Pure-FTPd): hostname.bundle / .key / .pem (CWP-MAP §10).
  const host = crypto.certificate({ name: ds.SERVER.hostname, names: [ds.SERVER.hostname], key: 'rsa', issuer: 'ca', validity: 'valid' });
  plan.file('/etc/pki/tls/certs/hostname.bundle', `${host.certPem}${host.chainPem}`);
  plan.file('/etc/pki/tls/private/hostname.key', host.keyPem, { mode: 0o600 });
  plan.file('/etc/pki/tls/private/hostname.pem', `${host.keyPem}${host.certPem}`, { mode: 0o600 });
  // The throw-away CA, for clients of the the Linux test host scenario (curl --cacert).
  plan.file('/etc/pki/ca-trust/source/anchors/fake-cwp-test-ca.crt', crypto.caCertificate());
}

export function renderSystemd(ds, plan) {
  plan.dir('/etc/systemd/system');
  for (const u of ds.SYSTEMD_UNITS) {
    const env = u.environment.map((e) => `Environment=${e}`).join('\n');
    plan.file(`/etc/systemd/system/${u.name}`, `[Unit]
Description=${u.name.replace(/\.service$/, '')} (fake-cwp: outside CWP)
After=network.target

[Service]
Type=simple
User=${u.user}
WorkingDirectory=${u.workingDirectory}
ExecStart=${u.execStart}
${env ? `${env}\n` : ''}Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`);
  }
  plan.file('/opt/monitor-agent/agent', '#!/bin/sh\nset -eu\n# monitoring agent stub (fake-cwp)\nexit 0\n', { mode: 0o755 });
  plan.file('/etc/monitor-agent.conf', 'server = https://monitor.example.net\ntoken = fake-cwp-must-never-be-read\n', { mode: 0o600 });
}
