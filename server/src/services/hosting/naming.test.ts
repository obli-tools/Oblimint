import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SITE_IMAGE_PREFIX, SITE_BASE_IDS } from '@oblimint/shared';
import { config } from '../../config';
import { siteImage } from './naming';

// Site base images honour OBLIMINT_SITE_IMAGE_PREFIX (test / private registry),
// like the edge / hostd / filesrv OBLIMINT_*_IMAGE overrides.

test('siteImage: default prefix meejay/oblimint- + base id + tag', () => {
  assert.equal(DEFAULT_SITE_IMAGE_PREFIX, 'meejay/oblimint-');
  const saved = { ...config.hosting };
  try {
    config.hosting.siteImagePrefix = DEFAULT_SITE_IMAGE_PREFIX;
    config.hosting.imageTag = 'latest';
    assert.equal(siteImage('nginx-php8.3'), 'meejay/oblimint-nginx-php8.3:latest');
  } finally {
    Object.assign(config.hosting, saved);
  }
});

test('siteImage: a configured prefix replaces the repository of every base', () => {
  const saved = { ...config.hosting };
  try {
    config.hosting.siteImagePrefix = 'registry.example:5000/oblimint-test/';
    config.hosting.imageTag = 'P1';
    assert.equal(siteImage('apache-php8.3'), 'registry.example:5000/oblimint-test/apache-php8.3:P1');
    for (const id of SITE_BASE_IDS) assert.equal(siteImage(id), `registry.example:5000/oblimint-test/${id}:P1`);
  } finally {
    Object.assign(config.hosting, saved);
  }
});
