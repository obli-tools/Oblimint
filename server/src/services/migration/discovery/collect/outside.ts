import { parseUnitFile } from '../parsers/systemd';
import { baseName, dirName } from '../parsers/system';
import { DiscoveryContext, homeOwner, isUnder } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Phase outside (P5-PLAN §7.4, CWP-MAP §11): everything the CWP model does not
// describe, listed as manual follow-ups — systemd services (Node / Python →
// a P4b Docker app is suggested; monitoring agents → ignore), proxies to a
// local service, git repositories and package.json outside the docroots,
// domlogs. (Linux users, SSH access, templates, Varnish backends, root crons,
// MySQL remote / orphan users, orphan / dynamic zones are added by their phase.)
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEMD_DIR = '/etc/systemd/system';
export const DOMLOGS_DIR = '/usr/local/apache/domlogs';
const AGENT_UNITS = /^(obliview|obliguard|oblimint)[-_.a-z0-9]*\.service$/i;

export async function phaseOutside(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const accounts = new Set(st.accounts.map((a) => a.username));

  // systemd units (regular files only: enablement symlinks point to stock units).
  const units = await ctx.find('systemd units', SYSTEMD_DIR, 1, 'f', '*.service');
  for (const u of units) {
    ctx.checkAbort();
    const r = await ctx.tryRun(`unit ${baseName(u.path)}`, 'sys.unitFile', { path: u.path });
    if (!r) continue;
    const facts = parseUnitFile(r.stdout);
    const name = baseName(u.path);
    st.units.push({ path: u.path, name, facts });
    const where = facts.workingDirectory ?? (facts.execStart?.match(/\/home\/[^\s'"]+/)?.[0] ?? null);
    const homeAccount = where ? homeOwner(where) : null;
    const account = facts.user && accounts.has(facts.user) ? facts.user : homeAccount && accounts.has(homeAccount) ? homeAccount : null;
    const agent = AGENT_UNITS.test(name);
    const kind = agent ? 'systemd-service' : facts.runtime === 'node' ? 'node-app' : facts.runtime === 'python' ? 'python-app' : 'systemd-service';
    ctx.addOutside({
      kind,
      key: name,
      account,
      code: kind === 'node-app' ? 'nodeApp' : kind === 'python-app' ? 'pythonApp' : 'systemdService',
      suggestion: agent ? 'ignore' : facts.runtime === 'other' ? 'manual' : 'docker-app',
      params: { unit: name, user: facts.user, runtime: facts.runtime },
      details: {
        unit: name, path: u.path, description: facts.description, user: facts.user, group: facts.group,
        workingDirectory: facts.workingDirectory, execStart: facts.execStart, runtime: facts.runtime,
        ports: facts.ports.join(',') || null, environmentFiles: facts.environmentFiles.join(',') || null,
        userIsCwpAccount: facts.user ? accounts.has(facts.user) : false, homeOf: homeAccount,
      },
    });
  }

  // Proxies to the source itself = a local service (matched with a unit port when possible).
  for (const lp of st.localProxies) {
    const unit = st.units.find((u) => u.facts.ports.includes(lp.port));
    const kind = unit?.facts.runtime === 'node' ? 'node-app' : unit?.facts.runtime === 'python' ? 'python-app' : 'other';
    ctx.addOutside({
      kind, key: `proxy:${lp.fqdn}`, account: lp.account, code: 'localProxyService', suggestion: 'docker-app',
      params: { fqdn: lp.fqdn, port: lp.port }, details: { fqdn: lp.fqdn, host: lp.host, port: lp.port, unit: unit?.name ?? null },
    });
  }

  // git repositories / package.json under the homes but outside every docroot.
  const docroots = st.domains.filter((d) => d.serving !== 'proxy' && d.serving !== 'redirect').map((d) => d.docroot).filter((x): x is string => !!x);
  const parents = docroots.filter((d) => /\/(public|web|www)$/.test(d)).map((d) => dirName(d));
  const inSite = (p: string) => docroots.some((d) => isUnder(p, d)) || parents.some((d) => p === d);
  for (const a of st.accounts) {
    ctx.checkAbort();
    for (const g of await ctx.find(`git repos of ${a.username}`, a.homeDir, 3, 'd', '.git')) {
      const repo = dirName(g.path);
      if (inSite(repo)) continue;
      ctx.addOutside({
        kind: 'git-repo', key: g.path, account: a.username, code: 'gitRepo', suggestion: 'manual',
        params: { path: repo }, details: { path: repo, inDocroot: false },
      });
    }
    for (const p of await ctx.find(`package.json of ${a.username}`, a.homeDir, 3, 'f', 'package.json')) {
      const dir = dirName(p.path);
      if (p.path.includes('/node_modules/') || inSite(dir)) continue;
      ctx.addOutside({
        kind: 'node-app', key: p.path, account: a.username, code: 'nodeApp', suggestion: 'docker-app',
        params: { path: dir }, details: { path: dir, packageJson: p.path, systemd: st.units.some((u) => (u.facts.workingDirectory ?? '') === dir) },
      });
    }
  }

  // domlogs (not migrated): size only.
  const du = await ctx.du('domlogs', [DOMLOGS_DIR]);
  const bytes = du.get(DOMLOGS_DIR);
  if (bytes !== undefined) {
    ctx.addOutside({
      kind: 'domlogs', key: DOMLOGS_DIR, account: null, code: 'domlogs', suggestion: 'ignore',
      params: { bytes }, details: { path: DOMLOGS_DIR, bytes },
    });
  }
}
