import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lexPhp, needsShortTagVariant } from './phpLexer';

// The lexer blanks only what PHP never runs, keeps offsets / newlines, and errs
// towards "code" wherever its reading could differ from PHP's.

const blankOf = (s: string) => s.replace(/[^\r\n]/g, ' ');

test('views keep the length and the newlines', () => {
  const src = "<?php\n/* a\n b */ $x = 'q\nr'; // c\necho \"d\";\n";
  const v = lexPhp(src);
  assert.equal(v.noComments.length, src.length);
  assert.equal(v.code.length, src.length);
  assert.equal(v.noComments.split('\n').length, src.split('\n').length);
  assert.equal(v.code.split('\n').length, src.split('\n').length);
});

test('comments are blanked in both views, single-quoted content in the code view only', () => {
  const src = "<?php /* $_GET */ # x\n// y\n$a = 'z'; $b = \"w\";";
  const v = lexPhp(src);
  assert.equal(v.noComments, `<?php ${blankOf('/* $_GET */')} ${blankOf('# x')}\n${blankOf('// y')}\n$a = 'z'; $b = "w";`);
  assert.equal(v.code, `<?php ${blankOf('/* $_GET */')} ${blankOf('# x')}\n${blankOf('// y')}\n$a = ' '; $b = "w";`);
});

test('inline HTML is never blanked', () => {
  const src = "<p>// not a comment 'x'</p><?php $a = 1; ?><p>/* html */</p>";
  const v = lexPhp(src);
  assert.ok(v.code.startsWith("<p>// not a comment 'x'</p>"));
  assert.ok(v.code.endsWith('<p>/* html */</p>'));
});

test('?> ends a line comment and PHP mode, not a block comment or a string', () => {
  const v = lexPhp('<?php // c ?> code <?php $a = 1;');
  assert.ok(v.code.includes('?> code <?php $a = 1;'));
  const b = lexPhp('<?php /* ?> */ $a = "?>"; echo 1;');
  assert.ok(b.code.includes('$a = "?>"; echo 1;'));
});

test('#[ is a PHP 8 attribute, not a comment', () => {
  const v = lexPhp('<?php #[Attr] system($x);');
  assert.ok(v.code.includes('#[Attr] system($x);'));
});

test('interpolation inside double-quoted strings and heredocs is lexed as code', () => {
  // The nested string " /* " does not open a comment that would hide the call.
  const src = '<?php $s = "{$a[" /* "]}"; run($x); /* end */';
  const v = lexPhp(src);
  assert.ok(v.code.includes('run($x);'), v.code);
  const h = lexPhp('<?php $s = <<<EOT\n{$a[" /* "]} $b\n  EOT;\nrun($x);\n');
  assert.ok(h.code.includes('run($x);'), h.code);
  const w = lexPhp('<?php $s = "${ f(\'}\') }"; run($x);');
  assert.ok(w.code.includes('run($x);'), w.code);
});

test('nowdoc content is blanked in the code view, heredoc content is kept', () => {
  const v = lexPhp("<?php $a = <<<'EOT'\n$_GET\nEOT;\n$b = <<<EOT\n$_POST\nEOT;\n");
  assert.ok(!v.code.includes('$_GET'));
  assert.ok(v.noComments.includes('$_GET'));
  assert.ok(v.code.includes('$_POST'));
});

test('backtick literals are reported (escapes, nesting), not backticks in strings or comments', () => {
  const src = "<?php /* `a` */ $q = 'SELECT `id`'; $o = `ls \\` {$d[\"`\"]}`; $p = \"`x`\";";
  const v = lexPhp(src);
  assert.equal(v.backticks.length, 1);
  const [s, e] = v.backticks[0];
  assert.equal(src.slice(s, e), '`ls \\` {$d["`"]}`');
});

test('short open tags: detection of the ambiguous bare <?', () => {
  assert.equal(needsShortTagVariant('<?php echo 1; ?> <?= $x ?>'), false);
  assert.equal(needsShortTagVariant('<? echo 1; ?>'), true);
  assert.equal(needsShortTagVariant('<?xml version="1.0"?>'), true);
  // With short tags on, a bare <? opens PHP mode.
  assert.ok(lexPhp("<? // x\n'a'", true).code.includes("' '"));
  assert.ok(lexPhp("<? // x\n'a'", false).code.includes("// x\n'a'"));
});

test('a hostile input is lexed in linear time without recursion', () => {
  const deep = '<?php $a = "' + '{$a["'.repeat(200_000);
  const t0 = Date.now();
  lexPhp(deep);
  lexPhp('<?php ' + '/*'.repeat(500_000));
  lexPhp('<?php ' + "<<<A\n".repeat(200_000));
  assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`);
});
