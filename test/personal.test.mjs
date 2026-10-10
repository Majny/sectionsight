/**
 * looksPersonal decides which path segments, section keys, names and utm
 * values may leave the page. It exists three times (k.js, collector.mjs,
 * posthog-guard.mjs, so each file can be copied alone); all three must agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { looksPersonal as collectorRule } from '../skills/sectionsight/assets/collector.mjs';
import { looksPersonal as guardRule, cleanUrl } from '../skills/sectionsight/assets/posthog-guard.mjs';

// k.js is a browser IIFE: take the marked block and evaluate it on its own.
const kjs = await readFile(new URL('../skills/sectionsight/assets/k.js', import.meta.url), 'utf8');
const block = /\/\/ <looksPersonal>[^\n]*\n([\s\S]*?)\/\/ <\/looksPersonal>/.exec(kjs);
assert.ok(block, 'k.js marks its looksPersonal block');
const trackerRule = new Function(`${block[1]}; return looksPersonal;`)();

const RULES = { 'k.js': trackerRule, 'collector.mjs': collectorRule, 'posthog-guard.mjs': guardRule };

// Path segments and other values that may identify someone or carry a credential.
const PERSONAL = [
  'V1StGXR8_Z5jdHi6B-myT', // nanoid
  'Xk9fA2bQ7z', // 10-character base62 code
  'AbCdEfGhIjKlMnOpQrStUvW', // 23 letters, mixed case
  'eyJhbGciOiJIUzI1NiJ9', // a JWT segment
  'k3j5h2g7f8d9s0a1', // 16 lowercase letters and digits
  'QmF2cjk4bmFfZXhhbXBsZQ', // base64url
  'jane@example.com',
  'jane%40example.com'.replace('%40', '@'),
  '9f8e7d6c5b4a32100123', // hex id
  '550e8400-e29b-41d4-a716-446655440000', // UUID
  '+420 123 456 789', // phone number
  'call-420-777-123-456',
  'Xk9f-A2bQ-7zPl-M3nR', // grouped codes with short parts
  'ABCD-1234-EFGH-5678',
  'reset_Ab3d_Ef7h_Ij9k',
  'ab12-cd34-ef56-gh78',
  'K7XQ9ZP2LM4R', // one case and digits, 10-15 characters
  'k3j5h2g7f8d9s0a',
  'XQ9ZP2LM4R',
  'ABCDEFGHJKLMNPQR', // 16 capitals
];

// Ordinary slugs and names that must stay readable.
const ORDINARY = [
  'pricing', 'how-it-works', '2026-10-08', 'blog', 'my-first-post', 'v2', 'index.html', 'section-3',
  'best-tools-for-2026', 'Getting_Started_With_Docker', 'ubuntu-22-04-lts', 'README', 'CHANGELOG-2026',
  'HowItWorks', 'JavaScript', 'spring-2026', 'spring_sale_2026', 'newsletter-2026-10', 'faq-1',
  'see-pricing', 'how-to-measure', '[id]', 'Main_Page', 'About-Us', 'iOS-17-review', 'h264-encoding-guide',
  'h2:How it works',
  // CamelCase product names and model numbers
  'iPhone15Pro', 'macOS-Sequoia-15', 'GalaxyS24Ultra', 'Microsoft365', 'Base64Encoder', 'React18Features',
  'EC2Instances', 'iPhone-15-Pro-Max', 'galaxy-s24-ultra', 'rtx-4090-review', 'covid19-update', 'Windows11',
  'm1-macbook-air-review', 'Q3-2026-results', 'node-v20-11-1', 'CONTRIBUTING',
];

// Known misses, documented in references/tracker.md: codes under 10
// characters, OTPs, 8-digit ids, name slugs, and a few random codes that
// happen to read like CamelCase words.
const KNOWN_MISSES = ['Xk9fA2bQ', '483920', '12345678', 'jane-doe'];

test('looksPersonal: tokens, ids, e-mails and phone numbers are personal', () => {
  for (const [name, rule] of Object.entries(RULES)) {
    for (const s of PERSONAL) assert.equal(rule(s), true, `${name} missed ${s}`);
  }
});

test('looksPersonal: ordinary slugs are not', () => {
  for (const [name, rule] of Object.entries(RULES)) {
    for (const s of ORDINARY) assert.equal(rule(s), false, `${name} dropped ${s}`);
  }
});

test('the three implementations agree on every value of a shared table', () => {
  const table = [...PERSONAL, ...ORDINARY, '', 'a', 'jane-doe', 'Ab3dEf7hIjK', 'iPhone15Pro', 'x'.repeat(30), '/blog/my-first-post', 'utm-AbCdEf12'];
  for (const s of table) {
    const answers = Object.entries(RULES).map(([name, rule]) => `${name}=${rule(s)}`);
    assert.equal(new Set(answers.map((a) => a.split('=')[1])).size, 1, `${JSON.stringify(s)}: ${answers.join(', ')}`);
  }
});

test('known misses stay documented: short codes and name slugs need the private-path rule', () => {
  for (const s of KNOWN_MISSES) assert.equal(collectorRule(s), false, s);
});

test('the three implementations agree on random strings too', () => {
  const al = 'aAbBzZ09_-./@ +%:#XkQ7';
  for (let i = 0; i < 20000; i++) {
    let s = '';
    const n = (i * 7919) % 40;
    for (let j = 0; j < n; j++) s += al[(i * 31 + j * 17 + ((i * j) % 13)) % al.length];
    const a = trackerRule(s), b = collectorRule(s), c = guardRule(s);
    assert.ok(a === b && b === c, JSON.stringify(s));
  }
});

test('path cleaning: token segments become [id], slugs stay', () => {
  assert.equal(cleanUrl('/invite/V1StGXR8_Z5jdHi6B-myT', 'https://example.com'), '/invite/[id]');
  assert.equal(cleanUrl('/s/eyJhbGciOiJIUzI1NiJ9', 'https://example.com'), '/s/[id]');
  assert.equal(cleanUrl('/blog/my-first-post', 'https://example.com'), '/blog/my-first-post');
});
