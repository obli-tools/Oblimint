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
// stream, and mailbox A's session trying to read mailbox B. Then the review
// fixes: a mailbox whose sending is cut (the sync's own diff applied to the
// engine) is refused through the proxy AND through direct JMAP with its own
// password; amplification requests refused, body values cut, long parts
// read from their blob, engine answers capped, concurrent calls bounded.
// The container is removed at the end, whatever happens. Output: TAP
// (ok / not ok, # pass / # fail).
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
import { buildDesiredPrincipals, diffPrincipals, toStalwartSecret } from '../../engines/stalwart/principals';
import type { DesiredMailbox, MailDesiredState } from '../../driver';
import { JMAP_USING } from './policy';
import { generateAdminSecret } from '../../engines/stalwart/secret';
import { createWebmailApp } from './app';
import { createWebmailAuth, type MailboxAuthRow } from './auth';
import { createStalwartWebmailEngine, WebmailEngineError, type WebmailEngine } from './engine';
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
    const pw = {
      alice: `Alice-${crypto.randomBytes(6).toString('hex')}`, bob: `Bob-${crypto.randomBytes(6).toString('hex')}`, carol: `Carol-${crypto.randomBytes(6).toString('hex')}`,
    };
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
    /** Mailboxes whose sending is cut (the panel's database rule, webmailSendAllowed in production). */
    const sendCut = new Set<number>();
    /** Each JMAP call held this long (concurrency check), 0 = none. */
    let callDelayMs = 0;
    const slowEngine: WebmailEngine = {
      ...engine,
      call: async (address, calls) => { if (callDelayMs) await sleep(callDelayMs); return engine.call(address, calls); },
    };
    const auth = createWebmailAuth({
      store: new MemoryWebmailSessionStore(),
      engine: slowEngine,
      now: Date.now,
      findMailboxByAddress: async (a) => rows.get(a) ?? null,
      findMailboxById: async (mid) => [...rows.values()].find((r) => r.id === mid) ?? null,
      redeemSso: async () => null,
      peekSso: async () => null,
      isBanned: async () => false,
      recordFailure: (ip, user) => { failures.push(`${ip} ${user}`); },
      maxUploadBytes: async () => 25 * 1048576,
    });
    const app = createWebmailApp({
      auth, engine: slowEngine, enabled: async () => true, secure: true, clientIp: () => '198.51.100.7', maxUploadBytes: async () => 25 * 1048576,
      sendAllowed: async (mid) => !sendCut.has(mid),
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
    check(A.status === 200 && !!A.cookie && !!A.accountId, 'alice logs in (panel hash; the password is never presented to Stalwart)', A);
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
    // As the client does: the list (light properties through a result reference), then the bodies by explicit ids.
    let got: Record<string, any> | null = null;
    for (let i = 0; i < 30 && !got; i++) {
      const q = await jmap(B, [
        ['Email/query', { filter: { inMailbox: mbB.inbox, subject }, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, limit: 5 }, 'q'],
        ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'threadId', 'subject', 'from', 'keywords', 'attachments', 'htmlBody', 'textBody', 'preview'], bodyProperties: ['partId', 'blobId', 'type', 'charset', 'name', 'size', 'disposition', 'cid'] }, 'g'],
      ]);
      got = q.body.methodResponses?.[1]?.[1]?.list?.[0] ?? null;
      if (!got) await sleep(1000);
    }
    if (got) {
      const bodies = await jmap(B, [['Email/get', { ids: [got.id], properties: ['id', 'bodyValues'], fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 256 * 1024 }, 'b']]);
      got.bodyValues = bodies.body.methodResponses?.[0]?.[1]?.list?.[0]?.bodyValues;
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

    // ══ review fixes ══

    // ── HIGH 1: sending cut → refused through the proxy AND through direct JMAP ──
    const carolAddr = `carol@${DOMAIN}`;
    const C = await login(carolAddr, pw.carol);
    check(C.status === 200, 'carol logs in', C.status);
    const mbC = await roles(C);
    const idC = C.identities?.find((i) => i.email === carolAddr)?.id ?? '';
    const sendAs = (who: typeof A, mb: Record<string, string>, idt: string, from: string, subj: string) => jmap(who, [
      ['Email/set', { create: { m: { mailboxIds: { [mb.drafts]: true }, keywords: { $draft: true }, from: [{ email: from }], to: [{ email: `bob@${DOMAIN}` }], subject: subj, textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: 'x' } } } } }, 'e'],
      ['EmailSubmission/set', { create: { s: { identityId: idt, emailId: '#m' } } }, 's'],
    ]);
    const before = await sendAs(C, mbC, idC, carolAddr, 'carol-before');
    check(before.status === 200 && !!before.body.methodResponses?.[1]?.[1]?.created?.s, 'carol can send before the suspension', before.body);
    // The account's outbound mail is suspended (anti-abuse): the desired state
    // marks the mailbox sendEnabled = false; the SYNC's own projection and diff
    // are applied to the engine.
    const mailbox = (r: MailboxAuthRow, sendEnabled: boolean): DesiredMailbox => ({
      id: r.id, accountId: r.accountId, domainId: 1, address: r.address, localPart: r.address.split('@')[0], domain: DOMAIN, displayName: r.displayName,
      passwordHash: r.passwordHash, passwordScheme: 'SHA512-CRYPT', quotaMb: null, loginEnabled: true, sendEnabled, receiveEnabled: true,
      sendPerHour: 200, forward: null, autoresponder: null,
    });
    const state = {
      generatedAt: new Date().toISOString(),
      settings: { hostname: `mail.${DOMAIN}`, maxMessageSizeMb: 25, spamTagScore: 6, spamRejectScore: 15, greylisting: false, clamav: false, clamdAddress: null },
      domains: [{ id: 1, accountId: 11, name: DOMAIN, active: true, catchAll: null, maxMessageSizeMb: 25 }],
      mailboxes: [...rows.values()].map((r) => mailbox(r, r.address !== carolAddr)),
      aliases: [], appPasswords: [], dkim: [], tls: [], relay: { relayHost: 'relay', relayAddresses: [] },
    } as unknown as MailDesiredState;
    const plan = diffPrincipals(buildDesiredPrincipals(state, new Date()), {
      domains: await api.listPrincipals('domain'), individuals: await api.listPrincipals('individual'), lists: [],
    }, { allowMassRemoval: false, knownSecrets: {} });
    const carolOps = [...plan.removals, ...plan.additions].filter((o) => o.name === carolAddr && o.ops?.length);
    for (const o of carolOps) await api.updatePrincipal(o.name, o.ops!);
    const permOps = [...plan.removals, ...plan.additions]
      .flatMap((o) => (o.ops ?? []).filter((p) => p.field === 'disabledPermissions').map((p) => `${o.name} ${p.action} ${String(p.value)}`)).sort();
    check(JSON.stringify(permOps) === JSON.stringify([`${carolAddr} addItem email-send`, `${carolAddr} addItem jmap-email-submission-set`]),
      "the sync diff revokes exactly carol's two sending permissions", permOps);
    const carolP = await api.getPrincipal(carolAddr);
    check(!!carolP && carolP.disabledPermissions.includes('email-send') && carolP.disabledPermissions.includes('jmap-email-submission-set'),
      'carol principal: email-send AND jmap-email-submission-set revoked by the sync', carolP?.disabledPermissions);
    sendCut.add(rows.get(carolAddr)!.id);
    const viaProxy = await sendAs(C, mbC, idC, carolAddr, 'carol-proxy-after');
    check(viaProxy.status === 403 && viaProxy.body.error === 'sendDisabled', 'carol via the webmail: refused by the proxy (sendDisabled)', viaProxy);
    // The proxy flag aside, the ENGINE refuses the impersonated submission too.
    const viaEngine = await engine.call(carolAddr, [
      ['Email/set', { accountId: C.accountId, create: { m: { mailboxIds: { [mbC.drafts]: true }, from: [{ email: carolAddr }], to: [{ email: `bob@${DOMAIN}` }], subject: 'carol-engine-after', textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: 'x' } } } } }, 'e'],
      ['EmailSubmission/set', { accountId: C.accountId, create: { s: { identityId: idC, emailId: '#m' } } }, 's'],
    ]);
    check(viaEngine.methodResponses[0]?.[0] === 'Email/set' && !!viaEngine.methodResponses[0]?.[1]?.created && viaEngine.methodResponses[1]?.[0] === 'error'
      && viaEngine.methodResponses[1]?.[1]?.type === 'forbidden', 'carol impersonated (bypassing the proxy): draft created, submission forbidden by Stalwart', viaEngine.methodResponses);
    const direct = await fetch(`http://${HOST}:${PORT}/jmap/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${carolAddr}:${pw.carol}`).toString('base64')}` },
      body: JSON.stringify({ using: [...JMAP_USING], methodCalls: [
        ['Email/set', { accountId: C.accountId, create: { m: { mailboxIds: { [mbC.drafts]: true }, from: [{ email: carolAddr }], to: [{ email: `bob@${DOMAIN}` }], subject: 'carol-direct-after', textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: 'x' } } } } }, 'e'],
        ['EmailSubmission/set', { accountId: C.accountId, create: { s: { identityId: idC, emailId: '#m' } } }, 's'],
      ] }),
    });
    const dj = await direct.json() as { methodResponses?: Array<[string, Record<string, any>, string]> };
    check(direct.status === 200 && dj.methodResponses?.[1]?.[0] === 'error' && dj.methodResponses?.[1]?.[1]?.type === 'forbidden',
      'carol direct JMAP with her own password: EmailSubmission/set forbidden by Stalwart', dj.methodResponses);
    await sleep(3000);
    const bobSees = await jmap(B, [['Email/query', { filter: { inMailbox: mbB.inbox, subject: 'carol-' } }, 'q'], ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g']]);
    const carolSubjects = ((bobSees.body.methodResponses?.[1]?.[1]?.list ?? []) as Array<{ subject: string }>).map((m) => m.subject).sort();
    check(JSON.stringify(carolSubjects) === JSON.stringify(['carol-before']), 'bob received only the message sent before the suspension', carolSubjects);
    // Lifted: the next sync gives the permissions back.
    const back = diffPrincipals(buildDesiredPrincipals({ ...state, mailboxes: [...rows.values()].map((r) => mailbox(r, true)) } as MailDesiredState, new Date()), {
      domains: await api.listPrincipals('domain'), individuals: await api.listPrincipals('individual'), lists: [],
    }, { allowMassRemoval: false, knownSecrets: {} });
    for (const o of [...back.removals, ...back.additions]) if (o.ops?.length) await api.updatePrincipal(o.name, o.ops);
    sendCut.clear();
    const lifted = await sendAs(C, mbC, idC, carolAddr, 'carol-lifted');
    check(lifted.status === 200 && !!lifted.body.methodResponses?.[1]?.[1]?.created?.s, 'suspension lifted: carol sends again', lifted.body.methodResponses?.[1]);

    // ── HIGH 2: amplification ──
    const big = 'A'.repeat(400 * 1024);
    const mk = await jmap(A, [['Email/set', { create: { m: { mailboxIds: { [mbA.drafts]: true }, subject: 'big', textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: big } } } } }, 'e']]);
    const bigId = mk.body.methodResponses?.[0]?.[1]?.created?.m?.id as string;
    check(!!bigId, 'a 400 KB message exists', mk.body);
    const amp = await fetch(`${base}/wm-api/jmap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: A.cookie, 'X-Oblimint-CSRF': A.csrf! },
      body: JSON.stringify({ methodCalls: [
        ['Email/get', { ids: Array(300).fill(bigId), properties: ['bodyValues', 'textBody'], fetchAllBodyValues: true }, 'g'],
        ['Email/get', { ids: Array(300).fill(bigId), properties: ['bodyValues', 'textBody'], fetchAllBodyValues: true }, 'h'],
      ] }),
    });
    const ampText = await amp.text();
    check(amp.status === 400 && ampText.length < 1000, "the review's amplification request (300 × the same id, all bodies, twice) is refused at once", { status: amp.status, bytes: ampText.length });
    const viaRef = await jmap(A, [['Email/query', { filter: {}, limit: 200 }, 'q'], ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, fetchAllBodyValues: true }, 'g']]);
    check(viaRef.status === 400, 'bodies through a result reference (uncountable ids) are refused', viaRef.status);
    const capped = await jmap(A, [['Email/get', { ids: [bigId], properties: ['bodyValues', 'textBody'], fetchAllBodyValues: true, maxBodyValueBytes: 2_000_000 }, 'g']]);
    const cv = capped.body.methodResponses?.[0]?.[1]?.list?.[0];
    const tPart = cv?.textBody?.[0]?.partId;
    check(capped.status === 200 && cv?.bodyValues?.[tPart]?.isTruncated === true && cv.bodyValues[tPart].value.length <= 256 * 1024,
      'maxBodyValueBytes capped at 256 KB: the value comes truncated', { len: cv?.bodyValues?.[tPart]?.value?.length, truncated: cv?.bodyValues?.[tPart]?.isTruncated });
    const partBlob = (await jmap(A, [['Email/get', { ids: [bigId], properties: ['textBody'], bodyProperties: ['partId', 'blobId', 'size', 'charset'] }, 'g']])).body.methodResponses?.[0]?.[1]?.list?.[0]?.textBody?.[0];
    const whole = partBlob?.blobId ? await fetch(`${base}/wm-api/blob/${encodeURIComponent(partBlob.blobId)}`, { headers: { Cookie: A.cookie } }) : null;
    const wholeText = whole ? Buffer.from(await whole.arrayBuffer()).toString('utf8') : '';
    check(whole?.status === 200 && wholeText.replace(/\r?\n/g, '') === big, 'the whole long part is read from its blob (streamed by the proxy)', { status: whole?.status, len: wholeText.length });
    const small = createStalwartWebmailEngine({ baseUrl: `http://${HOST}:${PORT}`, masterSecret: async () => admin.secret, maxResponseBytes: 64 * 1024 });
    let capErr: unknown = null;
    try {
      await small.call(`alice@${DOMAIN}`, [['Email/get', { accountId: A.accountId, ids: [bigId], properties: ['bodyValues'], fetchAllBodyValues: true, maxBodyValueBytes: 256 * 1024 }, 'g']]);
    } catch (err) { capErr = err; }
    check(capErr instanceof WebmailEngineError && capErr.status === 413, 'an engine answer over maxResponseBytes is dropped (413), not buffered', String(capErr));

    // ── concurrency: JMAP calls in flight per session ──
    callDelayMs = 800;
    const burst = await Promise.all(Array.from({ length: 6 }, () => jmap(A, [['Mailbox/get', { ids: null, properties: ['id'] }, 'm']])));
    callDelayMs = 0;
    const codes = burst.map((r) => r.status).sort();
    check(codes.filter((c) => c === 200).length === 4 && codes.filter((c) => c === 429).length === 2, '6 simultaneous calls of one session: 4 served, 2 refused (429)', codes);
    check((await jmap(A, [['Mailbox/get', { ids: null, properties: ['id'] }, 'm']])).status === 200, 'slots released afterwards');

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
