import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDomainInput, composeSubdomain, domainTreeKey, findParentDomain, ownLabel, subdomainLabel, subdomainLabelIssue } from './domainParent';

const domains = [
  { id: 1, name: 'example.com' },
  { id: 2, name: 'shop.example.com' },
  { id: 3, name: 'example.org' },
  { id: 4, name: 'xn--caf-dma.example' }, // café.example
];

test('findParentDomain: nearest (longest) domain strictly above the name', () => {
  assert.equal(findParentDomain('lucy.example.com', domains)?.id, 1);
  assert.equal(findParentDomain('a.b.example.com', domains)?.id, 1);
  assert.equal(findParentDomain('eu.shop.example.com', domains)?.id, 2, 'longest match wins');
  assert.equal(findParentDomain('x.y.shop.example.com', domains)?.id, 2);
  assert.equal(findParentDomain('www.example.org', domains)?.id, 3);
});

test('findParentDomain: the name itself, look-alikes and other names are not subdomains', () => {
  assert.equal(findParentDomain('example.com', domains), null, 'same name');
  assert.equal(findParentDomain('shop.example.com', domains)?.id, 1, 'an existing domain is below its own parent');
  assert.equal(findParentDomain('badexample.com', domains), null, 'suffix without a dot boundary');
  assert.equal(findParentDomain('lucy.example.net', domains), null);
  assert.equal(findParentDomain('', domains), null);
  assert.equal(findParentDomain('not a name', domains), null);
  assert.equal(findParentDomain('lucy.example.com', []), null);
});

test('findParentDomain: case, blanks and trailing dot are normalised', () => {
  assert.equal(findParentDomain('LUCY.Example.COM', domains)?.id, 1);
  assert.equal(findParentDomain('  lucy.example.com.  ', domains)?.id, 1);
  assert.equal(findParentDomain('Eu.Shop.Example.Com.', domains)?.id, 2);
});

test('findParentDomain: IDN names (punycode stored)', () => {
  assert.equal(findParentDomain('menu.café.example', domains)?.id, 4);
  assert.equal(findParentDomain('menu.xn--caf-dma.example', domains)?.id, 4);
  assert.equal(findParentDomain('crème.example.com', domains)?.id, 1);
});

test('subdomainLabel: label part below the parent', () => {
  assert.equal(subdomainLabel('LUCY.example.com', 'example.com'), 'lucy');
  assert.equal(subdomainLabel('a.b.example.com.', 'example.com'), 'a.b');
  assert.equal(subdomainLabel('example.com', 'example.com'), null);
  assert.equal(subdomainLabel('badexample.com', 'example.com'), null);
  assert.equal(subdomainLabel('menu.café.example', 'xn--caf-dma.example'), 'menu');
});

test('subdomainLabelIssue: label validation', () => {
  assert.equal(subdomainLabelIssue('lucy'), null);
  assert.equal(subdomainLabelIssue('a.b-c.d1'), null);
  assert.equal(subdomainLabelIssue('crème'), null, 'IDN label (checked once in punycode)');
  assert.equal(subdomainLabelIssue(''), 'empty');
  assert.equal(subdomainLabelIssue('a..b'), 'emptyLabel');
  assert.equal(subdomainLabelIssue('.a'), 'emptyLabel');
  assert.equal(subdomainLabelIssue('a.'), 'emptyLabel');
  assert.equal(subdomainLabelIssue('*'), 'wildcard');
  assert.equal(subdomainLabelIssue('*.a'), 'wildcard');
  assert.equal(subdomainLabelIssue('-a'), 'chars');
  assert.equal(subdomainLabelIssue('a-'), 'chars');
  assert.equal(subdomainLabelIssue('a_b'), 'chars');
  assert.equal(subdomainLabelIssue('a/b'), 'chars');
  assert.equal(subdomainLabelIssue('a'.repeat(64)), 'labelTooLong');
  assert.equal(subdomainLabelIssue('a'.repeat(63)), null);
});

test('composeSubdomain: full stored name', () => {
  assert.equal(composeSubdomain('LUCY', 'example.com'), 'lucy.example.com');
  assert.equal(composeSubdomain(' lucy ', 'example.com'), 'lucy.example.com');
  assert.equal(composeSubdomain('a.b', 'example.com'), 'a.b.example.com');
  assert.equal(composeSubdomain('lucy.example.com', 'example.com'), 'lucy.example.com', 'pasted full name');
  assert.equal(composeSubdomain('lucy.', 'example.com'), 'lucy.example.com');
  assert.equal(composeSubdomain('crème', 'example.com'), 'xn--crme-6oa.example.com');
  assert.equal(composeSubdomain('menu', 'xn--caf-dma.example'), 'menu.xn--caf-dma.example');
  assert.equal(composeSubdomain('', 'example.com'), null);
  assert.equal(composeSubdomain('a..b', 'example.com'), null);
  assert.equal(composeSubdomain('-a', 'example.com'), null);
  assert.equal(composeSubdomain('*', 'example.com'), null);
  assert.equal(composeSubdomain(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`, 'example.com'), null, 'name over 253');
});

test('ownLabel: cleaned label, pasted parent suffix removed', () => {
  assert.equal(ownLabel(' LUCY ', 'example.com'), 'lucy');
  assert.equal(ownLabel('Lucy.Example.com', 'example.com'), 'lucy');
  assert.equal(ownLabel('a.b.example.com.', 'example.com'), 'a.b');
  assert.equal(ownLabel('example.com', 'example.com'), 'example.com', 'the parent alone is not stripped to nothing');
  assert.equal(ownLabel('lucy.', 'example.com'), 'lucy');
});

test('cleanDomainInput / domainTreeKey', () => {
  assert.equal(cleanDomainInput(' LUCY.Example.com '), 'lucy.example.com');
  assert.equal(cleanDomainInput('a b'), 'ab');
  const sorted = ['example.org', 'shop.example.com', 'example.com', 'a.example.com'].sort((a, b) => domainTreeKey(a).localeCompare(domainTreeKey(b)));
  assert.deepEqual(sorted, ['example.com', 'a.example.com', 'shop.example.com', 'example.org']);
});
