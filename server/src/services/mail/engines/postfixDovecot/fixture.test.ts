import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { renderConfig } from './render';
import { baseState, CTX } from './testUtil';

// The image builds (images/mail-postfix, images/mail-rspamd) compile a fixture
// rendered by THIS renderer with the pinned Postfix / Dovecot / Pigeonhole /
// Rspamd versions: a configuration they would refuse fails the image build
// instead of the first start. This test keeps the fixture in sync:
//   OBLIMINT_UPDATE_MAIL_FIXTURES=1 node --import tsx --test src/services/mail/engines/postfixDovecot/fixture.test.ts
// (the DKIM private keys are not part of it: only the generated files).

const IMAGES = path.resolve(__dirname, '../../../../../../images');
const TARGETS: Array<{ dir: string; owns: (rel: string) => boolean; strip: (rel: string) => string }> = [
  { dir: path.join(IMAGES, 'mail-postfix', 'tests', 'fixture'), owns: (rel) => !rel.startsWith('rspamd/'), strip: (rel) => rel },
  { dir: path.join(IMAGES, 'mail-rspamd', 'tests', 'fixture'), owns: (rel) => rel.startsWith('rspamd/'), strip: (rel) => rel.slice('rspamd/'.length) },
];

function listFiles(dir: string, base = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(path.join(dir, e.name), rel) : [rel];
  });
}

test('image fixtures are the current output of the renderer', () => {
  const out = renderConfig(baseState(), CTX);
  for (const t of TARGETS) {
    const want = new Map([...out.files.entries()].filter(([rel]) => t.owns(rel)).map(([rel, c]) => [t.strip(rel), c]));
    if (process.env.OBLIMINT_UPDATE_MAIL_FIXTURES === '1') {
      fs.rmSync(t.dir, { recursive: true, force: true });
      for (const [rel, content] of want) {
        fs.mkdirSync(path.dirname(path.join(t.dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(t.dir, rel), content);
      }
    }
    assert.deepEqual(listFiles(t.dir).sort(), [...want.keys()].sort(), `${t.dir}: run with OBLIMINT_UPDATE_MAIL_FIXTURES=1`);
    for (const [rel, content] of want) {
      assert.equal(fs.readFileSync(path.join(t.dir, rel), 'utf8').replace(/\r\n/g, '\n'), content, `${rel} is stale: run with OBLIMINT_UPDATE_MAIL_FIXTURES=1`);
    }
  }
});
