/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END check of the Oblimint webmail against a REAL Stalwart (manual,
// never part of `npm test`: needs a Docker engine). Run from server/:
//
//   WM_E2E_DOCKER=tcp://<docker host>:2375 WM_E2E_HOST=<docker host address> \
//     node --import tsx src/services/mail/webmail/oblimint/e2e.stalwart.ts
//
// It renders the platform's Stalwart configuration (config.ts), runs a
// throwaway container of the pinned upstream release with it, creates one
// mail domain and two mailboxes through the admin API (exactly like the
// sync), then drives the webmail HTTP API (app.ts, real engine.ts) like a
// browser: login, list, read, send A → B, attachment round trip, event
// stream, and mailbox A's session trying to read mailbox B. The container is
// removed at the end, whatever happens. Output: TAP (ok / not ok, # pass / # fail).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import Docker from 'dockerode';
import tarFs from 'tar-fs';
import { hashMailPassword } from '../../passwords';
import { StalwartApi } from '../../engines/stalwart/api';
import { renderStalwartConfig } from '../../engines/stalwart/config';
import { ADMIN_HASH_ENV, ADMIN_USER, STALWART_VERSION } from '../../engines/stalwart/constants';
import { toStalwartSecret } from '../../engines/stalwart/principals';
import { generateAdminSecret } from '../../engines/stalwart/secret';
import { createWebmailApp } from './app';
import { createWebmailAuth, type MailboxAuthRow } from './auth';
import { createStalwartWebmailEngine } from './engine';
import { MemoryWebmailSessionStore } from './session';

const DOCKER = process.env.WM_E2E_DOCKER ?? '';
const HOST = process.env.WM_E2E_HOST ?? '';
const PORT = Number(process.env.WM_E2E_PORT ?? 18480);
const NAME = `oblimint-wm-e2e-${crypto.randomBytes(3).toString('hex')}`;
const IMAGE = `stalwartlabs/stalwart:v${STALWART_VERSION}`;
const DOMAIN = process.env.WM_E2E_DOMAIN ?? 'example.org';

let pass = 0;
let fail = 0;
let n = 0;
function check(cond: unknown, what: string, detail?: unknown): void {
  n++;
  if (cond) { pass++; console.log(`ok ${n} - ${what}`); } else { fail++; console.log(`not ok ${n} - ${what}${detail !== undefined ? ` # ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!DOCKER || !HOST) throw new Error('WM_E2E_DOCKER and WM_E2E_HOST are required');
  const u = new URL(DOCKER.replace(/^tcp:/, 'http:'));
  const docker = new Docker({ host: u.hostname, port: Number(u.port || 2375) });
  const admin = generateAdminSecret();
  const rendered = renderStalwartConfig({
    settings: { hostname: `mail.${DOMAIN}`, maxMessageSizeMb: 25, spamTagScore: 6, spamRejectScore: 15, greylisting: false, clamav: false, clamdAddress: null },
    domains: [{ id: 1, accountId: 1, name: DOMAIN, active: true, catchAll: null, maxMessageSizeMb: 25 }],
    sendLimits: { byDomain: { [DOMAIN]: 200 }, fallback: 20 },
    dkim: [],
    tls: [],
    relayAddresses: [],
    certRoots: [],
  } as Parameters<typeof renderStalwartConfig>[0]);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-e2e-'));
  fs.mkdirSync(path.join(work, 'oblimint', 'stalwart', 'dkim'), { recursive: true });
  fs.writeFileSync(path.join(work, 'oblimint', 'stalwart', 'config.toml'), rendered.toml);

  console.log(`# image ${IMAGE}, container ${NAME}, JMAP on ${HOST}:${PORT}`);
  const container = await docker.createContainer({
    name: NAME,
    Image: IMAGE,
    Entrypoint: ['/usr/local/bin/stalwart'],
    Cmd: ['--config', '/etc/oblimint/stalwart/config.toml'],
    Env: [`${ADMIN_HASH_ENV}=${admin.hash}`],
    ExposedPorts: { '8080/tcp': {} },
    HostConfig: {
      PortBindings: { '8080/tcp': [{ HostPort: String(PORT) }] },
      Tmpfs: { '/var/lib/stalwart': 'rw,size=256m', '/opt/stalwart': 'rw,size=16m' },
      AutoRemove: false,
    },
    Labels: { 'oblimint.e2e': 'webmail' },
  });
  let server: http.Server | null = null;
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

    // ── directory: one domain, two mailboxes (as the sync creates them) ──
    const pw = { alice: `Alice-${crypto.randomBytes(6).toString('hex')}`, bob: `Bob-${crypto.randomBytes(6).toString('hex')}` };
    const rows = new Map<string, MailboxAuthRow>();
    await api.createPrincipal({ type: 'domain', name: DOMAIN });
    let id = 0;
    for (const [who, secret] of Object.entries(pw)) {
      const address = `${who}@${DOMAIN}`;
      const stored = hashMailPassword(secret).hash;
      await api.createPrincipal({ type: 'individual', name: address, description: who, emails: [address], secrets: [toStalwartSecret(stored)], quota: 0, roles: ['user'], disabledPermissions: [] });
      id++;
      rows.set(address, {
        id, accountId: 10 + id, tenantId: 1, address, displayName: who, passwordHash: stored,
        mailboxEnabled: true, domainEnabled: true, domainVerified: true, accountStatus: 'active',
      });
    }

    // ── the webmail stack, real engine client ──
    const engine = createStalwartWebmailEngine({ baseUrl: `http://${HOST}:${PORT}`, masterSecret: async () => admin.secret });
    const failures: string[] = [];
    const auth = createWebmailAuth({
      store: new MemoryWebmailSessionStore(),
      engine,
      now: Date.now,
      findMailboxByAddress: async (a) => rows.get(a) ?? null,
      findMailboxById: async (mid) => [...rows.values()].find((r) => r.id === mid) ?? null,
      redeemSso: async () => null,
      isBanned: async () => false,
      recordFailure: (ip, user) => { failures.push(`${ip} ${user}`); },
      maxUploadBytes: async () => 25 * 1048576,
    });
    const app = createWebmailApp({
      auth, engine, enabled: async () => true, secure: true, clientIp: () => '198.51.100.7', maxUploadBytes: async () => 25 * 1048576,
      vacation: { get: async () => null, set: async (_m, v) => v }, clientDist: null, now: Date.now,
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const origin = base.replace('http:', 'https:');

    const login = async (address: string, password: string) => {
      const s = await fetch(`${base}/wm-api/session`);
      const pre = (s.headers.getSetCookie().find((c) => c.startsWith('__Host-oblimint-wm-csrf=')) ?? '').split(';')[0].split('=')[1];
      const r = await fetch(`${base}/wm-api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre },
        body: JSON.stringify({ address, password }),
      });
      const cookie = (r.headers.getSetCookie().find((c) => c.startsWith('__Host-oblimint-wm=')) ?? '').split(';')[0];
      const body = await r.json() as { csrf?: string; accountId?: string; identities?: Array<{ id: string; email: string }>; error?: string };
      return { status: r.status, cookie, ...body };
    };
    const jmap = async (s: { cookie: string; csrf?: string }, methodCalls: unknown[]) => {
      const r = await fetch(`${base}/wm-api/jmap`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: s.cookie, 'X-Oblimint-CSRF': s.csrf ?? '' },
        body: JSON.stringify({ methodCalls }),
      });
      return { status: r.status, body: await r.json() as { methodResponses?: Array<[string, Record<string, any>, string]>; error?: string } };
    };

    // ── login ──
    const wrong = await login(`alice@${DOMAIN}`, 'not-the-password');
    check(wrong.status === 401 && failures.length === 1, 'wrong password refused and fed to the ban service', wrong);
    const A = await login(`alice@${DOMAIN}`, pw.alice);
    const B = await login(`bob@${DOMAIN}`, pw.bob);
    check(A.status === 200 && !!A.cookie && !!A.accountId, 'alice logs in (panel hash + Stalwart)', A);
    check(B.status === 200 && !!B.cookie && !!B.accountId, 'bob logs in', B);
    check(A.accountId !== B.accountId, 'distinct JMAP accounts', [A.accountId, B.accountId]);
    check(!!A.identities?.some((i) => i.email === `alice@${DOMAIN}`), 'alice has an identity for her address', A.identities);
    const idA = A.identities?.find((i) => i.email === `alice@${DOMAIN}`)?.id ?? '';

    // ── list mailboxes ──
    const roles = async (s: typeof A) => {
      const r = await jmap(s, [['Mailbox/get', { ids: null, properties: ['id', 'name', 'role', 'unreadEmails', 'totalEmails'] }, 'm']]);
      const list = (r.body.methodResponses?.[0]?.[1]?.list ?? []) as Array<{ id: string; role: string | null; name: string }>;
      return Object.fromEntries(list.filter((m) => m.role).map((m) => [m.role!, m.id])) as Record<string, string>;
    };
    const mbA = await roles(A);
    const mbB = await roles(B);
    check(!!mbA.inbox && !!mbA.drafts && !!mbA.sent, 'alice: inbox / drafts / sent exist', mbA);
    check(!!mbB.inbox, 'bob: inbox exists', mbB);

    // ── event stream (bob) ──
    const events: string[] = [];
    const evCtrl = new AbortController();
    const evDone = (async () => {
      try {
        const r = await fetch(`${base}/wm-api/events`, { headers: { Cookie: B.cookie, 'X-Oblimint-Background': '1' }, signal: evCtrl.signal });
        events.push(`status ${r.status}`);
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          events.push(dec.decode(value));
        }
      } catch { /* aborted */ }
    })();
    await sleep(1500);

    // ── attachment upload (alice) ──
    const payload = crypto.randomBytes(48 * 1024);
    const up = await fetch(`${base}/wm-api/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', Origin: origin, Cookie: A.cookie, 'X-Oblimint-CSRF': A.csrf! }, body: payload,
    });
    const blob = await up.json() as { blobId?: string; size?: number };
    check(up.status === 200 && !!blob.blobId && blob.size === payload.length, 'attachment uploaded through the proxy', blob);

    // ── send alice → bob ──
    const subject = `e2e ${crypto.randomBytes(4).toString('hex')}`;
    const sent = await jmap(A, [
      ['Email/set', { create: { m: {
        mailboxIds: { [mbA.drafts]: true }, keywords: { $draft: true, $seen: true },
        from: [{ name: 'Alice', email: `alice@${DOMAIN}` }], to: [{ name: 'Bob', email: `bob@${DOMAIN}` }], subject,
        textBody: [{ partId: 't', type: 'text/plain' }],
        htmlBody: [{ partId: 'h', type: 'text/html' }],
        bodyValues: { t: { value: 'Hello Bob, plain.' }, h: { value: '<p>Hello <b>Bob</b><script>alert(1)</script></p>' } },
        attachments: [{ blobId: blob.blobId, type: 'application/pdf', name: 'rapport.pdf', disposition: 'attachment' }],
      } } }, 'e'],
      ['EmailSubmission/set', {
        create: { s: { identityId: idA, emailId: '#m' } },
        onSuccessUpdateEmail: { '#s': { [`mailboxIds/${mbA.drafts}`]: null, [`mailboxIds/${mbA.sent}`]: true, 'keywords/$draft': null } },
      }, 's'],
    ]);
    const created = sent.body.methodResponses?.[0]?.[1]?.created?.m;
    const submitted = sent.body.methodResponses?.[1]?.[1]?.created?.s;
    check(sent.status === 200 && !!created && !!submitted, 'alice sends to bob (Email/set + EmailSubmission/set)', sent.body);

    // ── bob receives ──
    let got: Record<string, any> | null = null;
    for (let i = 0; i < 30 && !got; i++) {
      const q = await jmap(B, [
        ['Email/query', { filter: { inMailbox: mbB.inbox, subject }, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, limit: 5 }, 'q'],
        ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'threadId', 'subject', 'from', 'keywords', 'attachments', 'htmlBody', 'textBody', 'bodyValues', 'preview'], fetchHTMLBodyValues: true, fetchTextBodyValues: true }, 'g'],
      ]);
      got = q.body.methodResponses?.[1]?.[1]?.list?.[0] ?? null;
      if (!got) await sleep(1000);
    }
    check(!!got && got.subject === subject, 'bob lists and reads the message', got?.subject);
    check(got?.from?.[0]?.email === `alice@${DOMAIN}`, 'From is alice', got?.from);
    const htmlPart = got?.htmlBody?.[0]?.partId;
    check(typeof got?.bodyValues?.[htmlPart]?.value === 'string' && got.bodyValues[htmlPart].value.includes('<b>Bob</b>'), 'HTML body delivered to the client (sanitized client side)');
    const att = (got?.attachments ?? [])[0] as { blobId?: string; name?: string } | undefined;
    check(att?.name === 'rapport.pdf' && !!att.blobId, 'attachment listed', got?.attachments);

    // ── attachment round trip ──
    if (att?.blobId) {
      const d = await fetch(`${base}/wm-api/blob/${encodeURIComponent(att.blobId)}?name=rapport.pdf`, { headers: { Cookie: B.cookie } });
      const bytes = Buffer.from(await d.arrayBuffer());
      check(d.status === 200 && crypto.createHash('sha256').update(bytes).digest('hex') === crypto.createHash('sha256').update(payload).digest('hex'),
        'attachment downloaded by bob is byte-identical', { status: d.status, len: bytes.length });
      check(/^attachment;/.test(d.headers.get('content-disposition') ?? '') && d.headers.get('content-type') === 'application/octet-stream'
        && d.headers.get('x-content-type-options') === 'nosniff', 'download headers: attachment, octet-stream, nosniff');
    }
    // ── isolation: a blob only bob has (his delivered message), his message id, his account ──
    const rawB = await jmap(B, [['Email/get', { ids: [got?.id], properties: ['blobId'] }, 'r']]);
    const bobBlob = rawB.body.methodResponses?.[0]?.[1]?.list?.[0]?.blobId as string | undefined;
    const aliceCopy = await jmap(A, [['Email/query', { filter: { inMailbox: mbA.sent } }, 'q'], ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['blobId'] }, 'g']]);
    const aliceBlobs = new Set(((aliceCopy.body.methodResponses?.[1]?.[1]?.list ?? []) as Array<{ blobId: string }>).map((x) => x.blobId));
    check(!!bobBlob && !aliceBlobs.has(bobBlob), "bob's delivered message has its own blob", { bobBlob, aliceBlobs: [...aliceBlobs] });
    if (bobBlob) {
      const steal = await fetch(`${base}/wm-api/blob/${encodeURIComponent(bobBlob)}`, { headers: { Cookie: A.cookie } });
      check(steal.status === 404 || steal.status === 403, "alice's session cannot download bob's message blob", steal.status);
    }
    const crossAcct = await jmap(A, [['Email/get', { accountId: B.accountId, ids: [got?.id] }, 'x']]);
    check(crossAcct.status === 403, "alice's session: accountId of bob refused by the proxy", crossAcct);
    // A message only bob has (his own draft): alice asks for its id and searches its secret subject.
    const secret = `zq${crypto.randomBytes(6).toString('hex')}`;
    const own = await jmap(B, [['Email/set', { create: { d: { mailboxIds: { [mbB.drafts]: true }, keywords: { $draft: true }, from: [{ email: `bob@${DOMAIN}` }], subject: secret, bodyValues: { t: { value: secret } }, textBody: [{ partId: 't', type: 'text/plain' }] } } }, 'd']]);
    const bobDraft = own.body.methodResponses?.[0]?.[1]?.created?.d?.id as string | undefined;
    check(!!bobDraft, 'bob saves a private draft', own.body);
    const peek = await jmap(A, [['Email/get', { ids: [bobDraft], properties: ['subject'] }, 'x']]);
    const peeked = (peek.body.methodResponses?.[0]?.[1]?.list ?? []) as Array<{ subject?: string }>;
    check(peek.status === 200 && !peeked.some((m) => m.subject === secret),
      "alice's session asking bob's draft id never gets bob's message (impersonation = alice's account only)", peek.body.methodResponses?.[0]?.[1]);
    const hunt = await jmap(A, [['Email/query', { filter: { text: secret } }, 'q']]);
    check(hunt.status === 200 && (hunt.body.methodResponses?.[0]?.[1]?.ids ?? []).length === 0, "alice's search for bob's secret finds nothing", hunt.body.methodResponses?.[0]);
    const mineB = await jmap(B, [['Email/query', { filter: { text: secret } }, 'q']]);
    check((mineB.body.methodResponses?.[0]?.[1]?.ids ?? []).length === 1, 'bob finds his own draft by full-text search', mineB.body.methodResponses?.[0]);
    const qB = await jmap(A, [['Email/query', { filter: { inMailbox: mbB.inbox } }, 'q']]);
    const idsQ = qB.body.methodResponses?.[0]?.[1]?.ids ?? [];
    check(!idsQ.includes(got?.id), "alice's session querying bob's inbox id sees none of bob's messages", qB.body.methodResponses?.[0]);
    const spoof = await jmap(A, [['Email/set', { create: { m: { mailboxIds: { [mbA.drafts]: true }, from: [{ email: `bob@${DOMAIN}` }], subject: 'x' } } }, 'e']]);
    check(spoof.status === 403, 'alice cannot write a message From bob (proxy)', spoof.status);
    const resend = await jmap(A, [['EmailSubmission/set', { create: { s: { identityId: idA, emailId: created?.id } } }, 's']]);
    check(resend.status === 403, 'an existing message cannot be re-submitted', resend.status);

    // ── flags / move (bob) ──
    const upd = await jmap(B, [['Email/set', { update: { [got?.id]: { 'keywords/$seen': true, 'keywords/$flagged': true } } }, 'u']]);
    check(upd.body.methodResponses?.[0]?.[1]?.updated && got?.id in upd.body.methodResponses[0][1].updated, 'bob marks read + flagged', upd.body);
    const trash = (await roles(B)).trash;
    if (trash) {
      const mv = await jmap(B, [['Email/set', { update: { [got?.id]: { [`mailboxIds/${mbB.inbox}`]: null, [`mailboxIds/${trash}`]: true } } }, 'u']]);
      check(!!mv.body.methodResponses?.[0]?.[1]?.updated, 'bob moves it to Trash', mv.body);
    }

    // ── search ──
    const s1 = await jmap(A, [['Email/query', { filter: { operator: 'AND', conditions: [{ to: `bob@${DOMAIN}` }, { hasAttachment: true }] } }, 'q']]);
    check((s1.body.methodResponses?.[0]?.[1]?.ids ?? []).length >= 1, 'search (to + hasAttachment) finds the sent copy', s1.body.methodResponses?.[0]);

    // ── events ──
    await sleep(2000);
    evCtrl.abort();
    await evDone;
    const evText = events.join('');
    check(events[0] === 'status 200' && /event: state/.test(evText) && evText.includes(String(B.accountId)), 'bob received a StateChange on the event stream', evText.slice(0, 300));
    const changedAccounts = new Set<string>();
    for (const m of evText.matchAll(/^data: (.*)$/gm)) {
      try { for (const k of Object.keys(JSON.parse(m[1]).changed ?? {})) changedAccounts.add(k); } catch { /* ping */ }
    }
    check(changedAccounts.size === 1 && changedAccounts.has(String(B.accountId)), "bob's stream only carries bob's account", [...changedAccounts]);

    // ── logout ──
    const lo = await fetch(`${base}/wm-api/logout`, { method: 'POST', headers: { Origin: origin, Cookie: A.cookie, 'X-Oblimint-CSRF': A.csrf! } });
    const after = await jmap(A, [['Mailbox/get', {}, 'm']]);
    check(lo.status === 200 && after.status === 401, 'logout ends the session', after.status);
  } finally {
    if (server) await new Promise<void>((r) => { server!.close(() => r()); server!.closeAllConnections?.(); });
    await container.remove({ force: true }).catch((err) => console.log(`# cleanup failed: ${(err as Error).message}`));
    fs.rmSync(work, { recursive: true, force: true });
    const left = await docker.listContainers({ all: true, filters: { label: ['oblimint.e2e=webmail'] } });
    check(left.length === 0, 'throwaway container removed', left.map((c) => c.Names));
    console.log(`1..${n}`);
    console.log(`# pass ${pass}`);
    console.log(`# fail ${fail}`);
  }
}

main().catch((err) => { console.log(`not ok - fatal: ${(err as Error).stack ?? err}`); console.log('# fail 1'); process.exitCode = 1; });
