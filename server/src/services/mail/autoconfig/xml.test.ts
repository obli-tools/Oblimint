import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autodiscoverRequestEmail, mtaStsPolicyText, normalizeEmail, outlookXml, thunderbirdXml, xmlEscape } from './xml';

test('xmlEscape: the five entities, control characters dropped', () => {
  assert.equal(xmlEscape(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  assert.equal(xmlEscape('a\u0000b\u0007c\nd'), 'abc\nd');
});

test('Thunderbird clientConfig v1.1: servers, ports, sockets, placeholder user name', () => {
  const xml = thunderbirdXml({ domain: 'exemple.fr', host: 'mail.host.net' });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<clientConfig version="1.1">/);
  assert.match(xml, /<emailProvider id="exemple.fr">/);
  assert.match(xml, /<incomingServer type="imap">\s*<hostname>mail.host.net<\/hostname>\s*<port>993<\/port>\s*<socketType>SSL<\/socketType>/);
  assert.match(xml, /<incomingServer type="pop3">\s*<hostname>mail.host.net<\/hostname>\s*<port>995<\/port>/);
  assert.match(xml, /<outgoingServer type="smtp">\s*<hostname>mail.host.net<\/hostname>\s*<port>465<\/port>\s*<socketType>SSL/);
  assert.match(xml, /<port>587<\/port>\s*<socketType>STARTTLS/);
  assert.ok(!/<port>25<\/port>/.test(xml), 'never port 25 for submission');
  assert.equal((xml.match(/%EMAILADDRESS%/g) ?? []).length, 5);
  // Hostile values stay inside their element.
  const evil = thunderbirdXml({ domain: 'x"><script>&', host: 'h</hostname><hostname>evil' });
  assert.ok(!evil.includes('<script>') && !evil.includes('<hostname>evil'));
  assert.ok(evil.includes('x&quot;&gt;&lt;script&gt;&amp;'));
});

test('Outlook POX response: outlook schema, IMAP 993 + SMTP 465, login = the requested address (escaped)', () => {
  const xml = outlookXml({ domain: 'exemple.fr', host: 'mail.host.net', email: "o'brien@exemple.fr" });
  assert.match(xml, /<Autodiscover xmlns="http:\/\/schemas.microsoft.com\/exchange\/autodiscover\/responseschema\/2006">/);
  assert.match(xml, /<Response xmlns="http:\/\/schemas.microsoft.com\/exchange\/autodiscover\/outlook\/responseschema\/2006a">/);
  assert.match(xml, /<Type>IMAP<\/Type>\s*<Server>mail.host.net<\/Server>\s*<Port>993<\/Port>/);
  assert.match(xml, /<Type>SMTP<\/Type>\s*<Server>mail.host.net<\/Server>\s*<Port>465<\/Port>/);
  assert.match(xml, /<LoginName>o&apos;brien@exemple.fr<\/LoginName>/);
  assert.equal((xml.match(/<SSL>on<\/SSL>/g) ?? []).length, 2);
});

test('autodiscover request parsing: EMailAddress only, bounded, no entity expansion', () => {
  const req = (inner: string) => `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request>${inner}<AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;
  assert.equal(autodiscoverRequestEmail(req('<EMailAddress> Contact@Exemple.FR </EMailAddress>')), 'contact@exemple.fr');
  assert.equal(autodiscoverRequestEmail(req('<a:EMailAddress>x@exemple.fr</a:EMailAddress>')), 'x@exemple.fr');
  assert.equal(autodiscoverRequestEmail(req('<EMailAddress>&xxe;@exemple.fr</EMailAddress>')), null);
  assert.equal(autodiscoverRequestEmail(req('<EMailAddress>not-an-address</EMailAddress>')), null);
  assert.equal(autodiscoverRequestEmail(req('')), null);
  assert.equal(autodiscoverRequestEmail(null), null);
  assert.equal(autodiscoverRequestEmail('x'.repeat(17 * 1024)), null);
});

test('normalizeEmail', () => {
  assert.equal(normalizeEmail(' A.B+c@Exemple.fr '), 'a.b+c@exemple.fr');
  for (const bad of ['a@b', '.a@b.fr', 'a..b@c.fr', 'a b@c.fr', 'a@-b.fr', 'a"@b.fr', 'a<@b.fr', `${'x'.repeat(65)}@b.fr`, '', null]) {
    assert.equal(normalizeEmail(bad as string | null), null, String(bad));
  }
});

test('MTA-STS policy: RFC 8461 fields, CRLF', () => {
  assert.equal(mtaStsPolicyText('enforce', 'mail.host.net'), 'version: STSv1\r\nmode: enforce\r\nmx: mail.host.net\r\nmax_age: 604800\r\n');
  // A hostile host name cannot inject a line.
  const text = mtaStsPolicyText('testing', 'MAIL.host.net\r\nmode: none');
  assert.equal(text.split('\r\n').length, 5);
  assert.ok(!text.includes('mode: none'));
});
