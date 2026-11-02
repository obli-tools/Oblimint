/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END check of the inbox rules / forwarding sieve script against a REAL
// Stalwart (manual, never part of `npm test`: needs a Docker engine). Run
// from server/:
//
//   WM_E2E_DOCKER=tcp://<docker host>:2375 WM_E2E_HOST=<docker host address> \
//     node --import tsx src/services/mail/webmail/oblimint/e2e.rules.stalwart.ts
//
// A throwaway container of the pinned release runs the platform's rendered
// configuration; three mailboxes are created through the admin API (as the
// sync does); the script engines/stalwart/sieve.ts renders for the rules is
// installed exactly like the sync installs it (api.setSieveScript, JMAP
// SieveScript impersonating the mailbox: the engine compiles it there, an
// unsupported extension fails right here). Then messages are sent alice →
// bob through JMAP and where they land is read back: folders (nested and
// non-ASCII), Deleted Items by role, discard, flags, forward (copy) and
// redirect to carol, stop, size, attachment, To / Cc, body. Then the
// forwarding without a copy (rules skipped) and the paused forwarding.
// Also: no ManageSieve on the platform's configuration (port 4190 silent), a
// foreign sieve script (what ManageSieve used to allow) never stays active
// once the sync installs / removes the panel's, a rule that redirects or
// deletes for good ends the rules (a later move does not file it again), and
// the forwarding notice imported straight into the Inbox (mailboxNotice.ts)
// stays there while the mailbox forwards without a copy.
// The container is removed at the end, whatever happens. Output: TAP.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import Docker from 'dockerode';
import tarFs from 'tar-fs';
import type { MailRule } from '@oblimint/shared';
import { hashMailPassword } from '../../passwords';
import { StalwartApi } from '../../engines/stalwart/api';
import { renderStalwartConfig } from '../../engines/stalwart/config';
import { ADMIN_HASH_ENV, ADMIN_USER, MASTER_USER, SIEVE_SCRIPT_NAME, STALWART_VERSION } from '../../engines/stalwart/constants';
import { renderSieveScript } from '../../engines/stalwart/sieve';
import { toStalwartSecret } from '../../engines/stalwart/principals';
import { generateAdminSecret } from '../../engines/stalwart/secret';
import { importNoticeIntoInbox } from '../../mailboxNotice';
import { folderPaths } from '../../rules';
import { createStalwartWebmailEngine } from './engine';

const DOCKER = process.env.WM_E2E_DOCKER ?? '';
const HOST = process.env.WM_E2E_HOST ?? '';
const PORT = Number(process.env.WM_E2E_PORT ?? 18481);
/** Host port mapped to the container's 4190 (must stay silent: no ManageSieve listener). */
const SIEVE_PORT = Number(process.env.WM_E2E_SIEVE_PORT ?? 18482);
const NAME = `oblimint-rules-e2e-${crypto.randomBytes(3).toString('hex')}`;
const IMAGE = `stalwartlabs/stalwart:v${STALWART_VERSION}`;
const DOMAIN = process.env.WM_E2E_DOMAIN ?? 'example.org';

let pass = 0;
let fail = 0;
let n = 0;
function check(cond: unknown, what: string, detail?: unknown): void {
  n++;
  if (cond) { pass++; console.log(`ok ${n} - ${what}`); } else { fail++; console.log(`not ok ${n} - ${what}${detail !== undefined ? ` # ${JSON.stringify(detail).slice(0, 600)}` : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rule = (id: string, over: Partial<MailRule>): MailRule => ({ id, name: id, enabled: true, match: 'all', conditions: [], actions: [{ kind: 'flag' }], stop: false, ...over });
const subj = (w: string): MailRule['conditions'][number] => ({ kind: 'subject', values: [w] });

async function main(): Promise<void> {
  if (!DOCKER || !HOST) throw new Error('WM_E2E_DOCKER and WM_E2E_HOST are required');
  const u = new URL(DOCKER.replace(/^tcp:/, 'http:'));
  const docker = new Docker({ host: u.hostname, port: Number(u.port || 2375) });
  try { await docker.getImage(IMAGE).inspect(); } catch {
    console.log(`# pulling ${IMAGE}`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
      });
    });
  }
  const admin = generateAdminSecret();
  const rendered = renderStalwartConfig({
    settings: { hostname: `mail.${DOMAIN}`, maxMessageSizeMb: 25, spamTagScore: 6, spamRejectScore: 15, greylisting: false, clamav: false, clamdAddress: null },
    domains: [{ id: 1, accountId: 1, name: DOMAIN, active: true, catchAll: null, maxMessageSizeMb: 25 }],
    sendLimits: { byDomain: { [DOMAIN]: 500 }, fallback: 50 },
    dkim: [],
    tls: [],
    relayAddresses: [],
    certRoots: [],
  } as Parameters<typeof renderStalwartConfig>[0]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-e2e-'));
  fs.mkdirSync(path.join(work, 'oblimint', 'stalwart', 'dkim'), { recursive: true });
  fs.writeFileSync(path.join(work, 'oblimint', 'stalwart', 'config.toml'), rendered.toml);

  console.log(`# image ${IMAGE}, container ${NAME}, HTTP on ${HOST}:${PORT}`);
  const container = await docker.createContainer({
    name: NAME,
    Image: IMAGE,
    Entrypoint: ['/usr/local/bin/stalwart'],
    Cmd: ['--config', '/etc/oblimint/stalwart/config.toml'],
    Env: [`${ADMIN_HASH_ENV}=${admin.hash}`],
    ExposedPorts: { '8080/tcp': {}, '4190/tcp': {} },
    HostConfig: {
      PortBindings: { '8080/tcp': [{ HostPort: String(PORT) }], '4190/tcp': [{ HostPort: String(SIEVE_PORT) }] },
      Tmpfs: { '/var/lib/stalwart': 'rw,size=256m', '/opt/stalwart': 'rw,size=16m' },
      AutoRemove: false,
    },
    Labels: { 'oblimint.e2e': 'rules' },
  });
  try {
    await container.putArchive(tarFs.pack(work), { path: '/etc' });
    await container.start();
    const api = new StalwartApi({ baseUrl: `http://${HOST}:${PORT}`, user: ADMIN_USER, secret: admin.secret, timeoutMs: 10_000 });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { ready = await api.ready(); if (!ready) await sleep(1000); }
    check(ready, 'Stalwart is up with the platform configuration');
    if (!ready) {
      const logs = await container.logs({ stdout: true, stderr: true, tail: 40 });
      console.log(logs.toString('utf8').split('\n').map((l) => `# ${l}`).join('\n'));
      return;
    }
    await api.replaceSettings([], rendered.settings);
    await api.reload().catch(() => undefined);

    // ── no ManageSieve: nothing answers on 4190 (a ManageSieve server greets at once with "IMPLEMENTATION" / "SIEVE") ──
    const banner = await new Promise<string>((resolve) => {
      let got = '';
      const sock = net.connect({ host: HOST, port: SIEVE_PORT });
      const done = () => { sock.destroy(); resolve(got); };
      sock.setTimeout(4000, done);
      sock.on('data', (d) => { got += d.toString('utf8'); if (got.length > 2000) done(); });
      sock.once('error', done);
      sock.once('close', done);
    });
    check(!/SIEVE|IMPLEMENTATION/i.test(banner), 'no ManageSieve listener in the platform configuration (port 4190 silent)', banner.slice(0, 200));

    await api.createPrincipal({ type: 'domain', name: DOMAIN });
    for (const who of ['alice', 'bob', 'carol']) {
      const address = `${who}@${DOMAIN}`;
      await api.createPrincipal({
        type: 'individual', name: address, description: who, emails: [address],
        secrets: [toStalwartSecret(hashMailPassword(`P-${crypto.randomBytes(6).toString('hex')}`).hash)], quota: 0, roles: ['user'], disabledPermissions: [],
      });
    }
    const A = `alice@${DOMAIN}`;
    const B = `bob@${DOMAIN}`;
    const C = `carol@${DOMAIN}`;
    const engine = createStalwartWebmailEngine({ baseUrl: `http://${HOST}:${PORT}`, masterSecret: async () => admin.secret });
    const acct = async (address: string) => (await engine.endpoints(address)).accountId;
    const call = async (address: string, calls: Array<[string, Record<string, unknown>, string]>) => {
      const accountId = await acct(address);
      const out = await engine.call(address, calls.map(([m, a, id]) => [m, { accountId, ...a }, id] as [string, Record<string, unknown>, string]));
      return out.methodResponses as Array<[string, Record<string, any>, string]>;
    };
    const mailboxes = async (address: string) => {
      const r = await call(address, [['Mailbox/get', { ids: null, properties: ['id', 'name', 'parentId', 'role'] }, 'm']]);
      return (r[0]?.[1]?.list ?? []) as Array<{ id: string; name: string; parentId: string | null; role: string | null }>;
    };

    // ── bob's folders: top level, nested, non-ASCII ──
    let mbB = await mailboxes(B);
    const inboxB = mbB.find((m) => m.role === 'inbox')!;
    const trashB = mbB.find((m) => m.role === 'trash');
    check(!!inboxB && !!trashB, 'bob has an Inbox and a Deleted Items (role trash)', mbB.map((m) => [m.name, m.role]));
    const created = await call(B, [['Mailbox/set', { create: {
      f: { name: 'Finance', parentId: null }, p: { name: 'Projets', parentId: null }, c: { name: 'Clients', parentId: '#p' },
      pj: { name: 'Pièces jointes', parentId: null }, g: { name: 'Gros', parentId: null }, cc: { name: 'Copies', parentId: null },
      sub: { name: 'Sous', parentId: inboxB.id },
    } }, 's']]);
    check(Object.keys(created[0]?.[1]?.created ?? {}).length === 7, 'bob: folders created through JMAP', created[0]?.[1]);
    mbB = await mailboxes(B);
    const paths = folderPaths(mbB);
    check(paths.includes('Projets/Clients') && paths.includes('Pièces jointes') && paths[0] === 'INBOX', 'folder paths as the panel lists them', paths);

    // ── the rules (order matters: stop on 'stopper') ──
    const rules: MailRule[] = [
      rule('facture', { conditions: [subj('facture')], actions: [{ kind: 'move', folder: 'Finance' }, { kind: 'markRead' }], stop: true }),
      rule('projet', { conditions: [subj('projet')], actions: [{ kind: 'move', folder: 'Projets/Clients' }, { kind: 'flag' }] }),
      rule('corbeille', { conditions: [subj('corbeille')], actions: [{ kind: 'delete' }] }),
      rule('jeter', { conditions: [subj('jeter')], actions: [{ kind: 'discard' }] }),
      rule('copie', { conditions: [subj('copie')], actions: [{ kind: 'forward', to: [C] }] }),
      rule('renvoi', { conditions: [subj('renvoi')], actions: [{ kind: 'redirect', to: [C] }] }),
      rule('pj', { conditions: [{ kind: 'hasAttachment' }], actions: [{ kind: 'move', folder: 'Pièces jointes' }] }),
      rule('urgent', { conditions: [{ kind: 'body', values: ['urgentissime'] }], actions: [{ kind: 'flag' }] }),
      rule('stop1', { match: 'all', conditions: [{ kind: 'from', values: ['alice'] }, subj('stopper')], actions: [{ kind: 'markRead' }], stop: true }),
      rule('stop2', { conditions: [subj('stopper')], actions: [{ kind: 'flag' }] }),
      rule('gros', { conditions: [{ kind: 'sizeOver', kb: 200 }], actions: [{ kind: 'move', folder: 'Gros' }] }),
      rule('cc', { conditions: [{ kind: 'toCc', values: ['carol@'] }], actions: [{ kind: 'move', folder: 'Copies' }] }),
      rule('anyof', { match: 'any', conditions: [subj('alpha-x'), subj('beta-x')], actions: [{ kind: 'move', folder: 'INBOX/Sous' }] }),
      rule('off', { enabled: false, conditions: [subj('desactive')], actions: [{ kind: 'discard' }] }),
      // After a discard / a redirect the message is gone: these must not file it again (the rule above ends the rules).
      rule('apres-jeter', { conditions: [subj('jeter')], actions: [{ kind: 'move', folder: 'Gros' }] }),
      rule('apres-renvoi', { conditions: [subj('renvoi')], actions: [{ kind: 'move', folder: 'Gros' }] }),
    ];
    const script = renderSieveScript({ address: B, forward: null, autoresponder: { subject: 'Absent', body: 'Back soon', startsAt: null, endsAt: null, intervalDays: 1 }, rules })!;
    let installErr: unknown = null;
    try { await api.setSieveScript(B, MASTER_USER, admin.secret, SIEVE_SCRIPT_NAME, script); } catch (err) { installErr = err; }
    check(!installErr, 'the rendered rules script compiles and is activated on the engine (every extension supported)', String((installErr as Error)?.message ?? ''));

    // ── a foreign script (uploaded the way ManageSieve did) never stays the active one ──
    const sieveAs = async (address: string) => {
      const auth = `Basic ${Buffer.from(`${address}%${MASTER_USER}:${admin.secret}`).toString('base64')}`;
      const base = `http://${HOST}:${PORT}`;
      const sess = await (await fetch(`${base}/.well-known/jmap`, { headers: { Authorization: auth } })).json() as { primaryAccounts: Record<string, string> };
      const accountId = sess.primaryAccounts['urn:ietf:params:jmap:sieve'] ?? sess.primaryAccounts['urn:ietf:params:jmap:mail'];
      const jcall = async (methodCalls: unknown[]) => ((await (await fetch(`${base}/jmap/`, {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:sieve'], methodCalls }),
      })).json()) as { methodResponses: Array<[string, Record<string, any>, string]> }).methodResponses;
      return {
        async scripts(): Promise<Record<string, boolean>> {
          const r = await jcall([['SieveScript/get', { accountId, ids: null, properties: ['name', 'isActive'] }, 'g']]);
          return Object.fromEntries(((r[0]?.[1]?.list ?? []) as Array<{ name: string; isActive: boolean }>).map((x) => [x.name, !!x.isActive]));
        },
        async plant(name: string, raw: string): Promise<boolean> {
          const up = await (await fetch(`${base}/jmap/upload/${accountId}/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/sieve' }, body: raw })).json() as { blobId: string };
          const r = await jcall([['SieveScript/set', { accountId, create: { f: { name, blobId: up.blobId } }, onSuccessActivateScript: '#f' }, 's']]);
          return !!r[0]?.[1]?.created?.f;
        },
      };
    };
    const bobSieve = await sieveAs(B);
    const foreign = `redirect "${C}";\r\ndiscard;\r\n`;
    check(await bobSieve.plant('roundcube1', foreign), 'a foreign script can be planted and activated (what ManageSieve allowed)', await bobSieve.scripts());
    await api.setSieveScript(B, MASTER_USER, admin.secret, SIEVE_SCRIPT_NAME, script);
    let sc = await bobSieve.scripts();
    check(sc[SIEVE_SCRIPT_NAME] === true && sc.roundcube1 === false, 'installing the panel script deactivates the foreign one (kept, inactive)', sc);

    // ── send alice → bob ──
    const accountA = await acct(A);
    const idA = (await engine.identities(A, accountA, 'Alice')).find((i) => i.email === A)?.id ?? '';
    const mbA = await mailboxes(A);
    const draftsA = mbA.find((m) => m.role === 'drafts')!.id;
    const tag = crypto.randomBytes(3).toString('hex');
    const send = async (subject: string, opts: { body?: string; cc?: string[]; attach?: boolean } = {}) => {
      let attachments: unknown[] | undefined;
      if (opts.attach) {
        const up = await engine.upload(A, accountA, 'application/pdf', new Uint8Array(crypto.randomBytes(2048)));
        attachments = [{ blobId: up.blobId, type: 'application/pdf', name: 'doc.pdf', disposition: 'attachment' }];
      }
      const r = await call(A, [
        ['Email/set', { create: { m: {
          mailboxIds: { [draftsA]: true }, keywords: { $draft: true },
          from: [{ name: 'Alice', email: A }], to: [{ name: 'Bob', email: B }], ...(opts.cc ? { cc: opts.cc.map((e) => ({ email: e })) } : {}),
          subject: `${subject} ${tag}`, textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: opts.body ?? 'Bonjour.' } },
          ...(attachments ? { attachments } : {}),
        } } }, 'e'],
        ['EmailSubmission/set', { create: { s: { identityId: idA, emailId: '#m' } }, onSuccessDestroyEmail: ['#s'] }, 's'],
      ]);
      return !!r[1]?.[1]?.created?.s;
    };
    const cases: Array<[string, Parameters<typeof send>[1]]> = [
      ['facture mars', {}], ['projet lune', {}], ['corbeille vieux', {}], ['jeter ceci', {}], ['copie pour carol', {}], ['renvoi direct', {}],
      ['rapport', { attach: true }], ['message simple', { body: 'Ceci est urgentissime, merci.' }], ['stopper ici', {}],
      ['lourd', { body: 'x'.repeat(260 * 1024) }], ['avec carol', { cc: [C] }], ['beta-x test', {}], ['desactive test', {}], ['facture projet', {}],
    ];
    let sent = 0;
    for (const [s, o] of cases) if (await send(s, o)) sent++;
    check(sent === cases.length, 'alice sent every test message', { sent, total: cases.length });

    // ── where did they land? ──
    const names = new Map(mbB.map((m) => [m.id, m.name]));
    const find = async (address: string, subject: string) => {
      // Exact subject, compared here: the engine's subject filter is a full-text search
      // (word matching, asynchronous indexing) and mixes "facture mars" with "facture juin".
      const r = await call(address, [
        ['Email/query', { sort: [{ property: 'receivedAt', isAscending: false }], limit: 500 }, 'q'],
        ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'mailboxIds', 'keywords'] }, 'g'],
      ]);
      const list = (r[1]?.[1]?.list ?? []) as Array<{ subject: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }>;
      return list.filter((e) => e.subject === `${subject} ${tag}`);
    };
    // Delivery is asynchronous: wait for the last one (or a timeout).
    for (let i = 0; i < 40; i++) {
      if ((await find(B, 'facture projet')).length && (await find(C, 'renvoi direct')).length) break;
      await sleep(1000);
    }
    await sleep(1500);
    const at = async (subject: string) => {
      const list = await find(B, subject);
      return list.map((e) => ({ boxes: Object.keys(e.mailboxIds).map((id) => names.get(id) ?? id).sort(), seen: !!e.keywords?.$seen, flagged: !!e.keywords?.$flagged }));
    };
    const inbox = inboxB.name;
    const facture = await at('facture mars');
    check(facture.length === 1 && facture[0].boxes.join() === 'Finance' && facture[0].seen, 'move + mark read (Finance)', facture);
    const projet = await at('projet lune');
    check(projet.length === 1 && projet[0].boxes.join() === 'Clients' && projet[0].flagged && !projet[0].seen, 'move into a nested folder (Projets/Clients) + flag', projet);
    const corbeille = await at('corbeille vieux');
    check(corbeille.length === 1 && corbeille[0].boxes.join() === trashB?.name, 'delete = Deleted Items (found by its role)', corbeille);
    check((await at('jeter ceci')).length === 0, 'discard: not delivered, a later move rule does not file it again');
    const copie = await at('copie pour carol');
    check(copie.length === 1 && copie[0].boxes.join() === inbox, 'forward: bob keeps it in the Inbox', copie);
    check((await find(C, 'copie pour carol')).length === 1, 'forward: carol got a copy');
    const renvoi = await at('renvoi direct');
    check(renvoi.length === 0, 'redirect: bob does not keep it, a later move rule does not file it again', renvoi);
    check((await find(C, 'renvoi direct')).length === 1, 'redirect: carol got it');
    const pj = await at('rapport');
    check(pj.length === 1 && pj[0].boxes.join() === 'Pièces jointes', 'attachment test (mime) + non-ASCII folder', pj);
    const urgent = await at('message simple');
    check(urgent.length === 1 && urgent[0].flagged && urgent[0].boxes.join() === inbox, 'body test: flagged, stays in the Inbox', urgent);
    const stopper = await at('stopper ici');
    check(stopper.length === 1 && stopper[0].seen && !stopper[0].flagged, 'stop: the rules below did not run (read, not flagged)', stopper);
    const lourd = await at('lourd');
    check(lourd.length === 1 && lourd[0].boxes.join() === 'Gros', 'size over 200 KB → Gros', lourd);
    const cc = await at('avec carol');
    check(cc.length === 1 && cc[0].boxes.join() === 'Copies', 'To / Cc test → Copies', cc);
    const anyof = await at('beta-x test');
    check(anyof.length === 1 && anyof[0].boxes.join() === 'Sous', 'any-of rule, sub-folder of the Inbox (INBOX/Sous)', anyof);
    const off = await at('desactive test');
    check(off.length === 1 && off[0].boxes.join() === inbox, 'a disabled rule does nothing', off);
    const both = await at('facture projet');
    check(both.length === 1 && both[0].boxes.join() === 'Finance' && !both[0].flagged, 'first matching rule with stop wins (no Projets copy)', both);

    // ── forwarding without a copy: rules skipped, nothing kept ──
    const script2 = renderSieveScript({ address: B, forward: { targets: [C], keepCopy: false }, autoresponder: null, rules })!;
    installErr = null;
    try { await api.setSieveScript(B, MASTER_USER, admin.secret, SIEVE_SCRIPT_NAME, script2); } catch (err) { installErr = err; }
    check(!installErr, 'forwarding (no copy) + rules script accepted', String((installErr as Error)?.message ?? ''));
    await send('facture avril');
    for (let i = 0; i < 30 && !(await find(C, 'facture avril')).length; i++) await sleep(1000);
    await sleep(1000);
    check((await find(C, 'facture avril')).length === 1, 'forwarding without a copy: carol gets it');
    const avril = await at('facture avril');
    check(avril.length === 0, 'forwarding without a copy: bob keeps nothing (rules not run)', avril);
    // The notice e-mail bypasses the script: imported into bob's Inbox, never handed to carol.
    let noticeErr: unknown = null;
    try { await importNoticeIntoInbox(engine, B, `avis ${tag}`, 'Vos e-mails sont transférés vers carol.', new Date()); } catch (err) { noticeErr = err; }
    await sleep(1500);
    const avis = await at('avis');
    check(!noticeErr && avis.length === 1 && avis[0].boxes.join() === inbox && !avis[0].seen, 'the forwarding notice lands in the Inbox (unread) although nothing else is kept', { err: String((noticeErr as Error)?.message ?? ''), avis });
    check((await find(C, 'avis')).length === 0, 'the notice is not forwarded to carol');

    // ── forwarding with a copy: rules still sort bob's copy ──
    const script3 = renderSieveScript({ address: B, forward: { targets: [C], keepCopy: true }, autoresponder: null, rules })!;
    await api.setSieveScript(B, MASTER_USER, admin.secret, SIEVE_SCRIPT_NAME, script3);
    await send('facture mai');
    for (let i = 0; i < 30 && !(await find(C, 'facture mai')).length; i++) await sleep(1000);
    await sleep(1000);
    const mai = await at('facture mai');
    check((await find(C, 'facture mai')).length === 1 && mai.length === 1 && mai[0].boxes.join() === 'Finance', 'forwarding with a copy: carol gets it, bob\'s copy sorted by the rules', mai);

    // ── no rule, no forwarding: script removed — and a foreign active script deactivated with it ──
    check(await bobSieve.plant('roundcube2', foreign), 'a second foreign script planted and activated');
    let removeErr: unknown = null;
    try { await api.setSieveScript(B, MASTER_USER, admin.secret, SIEVE_SCRIPT_NAME, null); } catch (err) { removeErr = err; }
    check(!removeErr, 'the panel script is removed (deactivated, then destroyed)', String((removeErr as Error)?.message ?? ''));
    sc = await bobSieve.scripts();
    check(!(SIEVE_SCRIPT_NAME in sc) && Object.values(sc).every((a) => !a), 'no script stays active (the foreign one deactivated)', sc);
    // And with nothing of the panel's at all: still enforced.
    check(await bobSieve.plant('roundcube3', foreign), 'a third foreign script planted on a mailbox without a panel script');
    await api.setSieveScript(B, MASTER_USER, admin.secret, SIEVE_SCRIPT_NAME, null);
    sc = await bobSieve.scripts();
    check(Object.values(sc).every((a) => !a), 'removal on a mailbox without a panel script deactivates it too', sc);
    check(await send('facture juin'), 'sent after the removal');
    for (let i = 0; i < 30 && !(await at('facture juin')).length; i++) await sleep(1000);
    const juin = await at('facture juin');
    check(juin.length === 1 && juin[0].boxes.join() === inbox, 'script removed: plain delivery to the Inbox', juin);
    check((await find(C, 'facture juin')).length === 0, 'the foreign scripts do not run (nothing redirected to carol)');

    // ── engine probes (raw scripts): how redirect / discard / keep combine on this release ──
    if (process.env.WM_E2E_PROBES) {
      const probe = async (label: string, raw: string) => {
        let err: unknown = null;
        try { await api.setSieveScript(B, MASTER_USER, admin.secret, SIEVE_SCRIPT_NAME, raw); } catch (e) { err = e; }
        await send(`probe ${label}`);
        for (let i = 0; i < 20 && !(await find(C, `probe ${label}`)).length; i++) await sleep(1000);
        await sleep(1500);
        console.log(`# probe ${label}: install ${err ? String((err as Error).message) : 'ok'}, bob ${JSON.stringify(await at(`probe ${label}`))}, carol ${(await find(C, `probe ${label}`)).length}`);
      };
      await probe('p1', `redirect "${C}";\r\n`);
      await probe('p2', `redirect "${C}";\r\ndiscard;\r\n`);
      await probe('p3', `redirect "${C}";\r\nstop;\r\n`);
      await probe('p4', `require ["copy"];\r\nredirect :copy "${C}";\r\n`);
      await probe('p5', `if true {\r\n  redirect "${C}";\r\n}\r\n`);
      await probe('p6', `require ["fileinto", "special-use"];\r\nredirect "${C}";\r\nfileinto :specialuse "\\\\Trash" "Deleted Items";\r\n`);
      await probe('p7', `discard;\r\nredirect "${C}";\r\n`);
      await probe('p8', `require ["fileinto"];\r\nredirect "${C}";\r\nfileinto "Gros";\r\n`);
      await probe('p9', `require ["copy"];\r\nredirect :copy "${C}";\r\ndiscard;\r\n`);
    }
  } finally {
    await container.remove({ force: true }).catch((err) => console.log(`# cleanup failed: ${(err as Error).message}`));
    fs.rmSync(work, { recursive: true, force: true });
    const left = await docker.listContainers({ all: true, filters: { label: ['oblimint.e2e=rules'] } });
    check(left.length === 0, 'throwaway container removed', left.map((c) => c.Names));
    console.log(`1..${n}`);
    console.log(`# pass ${pass}`);
    console.log(`# fail ${fail}`);
  }
}

main().catch((err) => { console.log(`not ok - fatal: ${(err as Error).stack ?? err}`); console.log('# fail 1'); process.exitCode = 1; });
