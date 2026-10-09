// ─────────────────────────────────────────────────────────────────────────────
// Test samples of POST /api/system/scanner/test (docs/P3-PLAN.md §6.7). Both
// are ASSEMBLED AT RUN TIME (base64 / fragments) so that no source file of the
// panel is itself a detectable sample (antivirus on dev boxes and CI).
// ─────────────────────────────────────────────────────────────────────────────

/** The EICAR anti-virus test string (68 bytes, harmless by design). */
export function eicarSample(): Buffer {
  return Buffer.from('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=', 'base64');
}

/**
 * A minimal "known webshell" pattern: request-driven eval of decoded data,
 * a command run from the request and a classic webshell marker. It never
 * leaves the panel / scanner memory (sent to scand, never written to a site).
 */
export function webshellSample(): Buffer {
  const ev = ['e', 'v', 'a', 'l'].join('');
  const dec = ['base64', '_', 'decode'].join('');
  const sys = ['sys', 'tem'].join('');
  const post = ['$', '_POST'].join('');
  const req = ['$', '_REQUEST'].join('');
  const marker = ['Files', 'Man'].join('');
  return Buffer.from([
    '<?php',
    `// ${marker} test sample (Oblimint scanner self-test)`,
    `@${ev}(${dec}(${post}['p']));`,
    `if (isset(${req}['c'])) { ${sys}(${req}['c']); }`,
    '',
  ].join('\n'), 'utf8');
}
