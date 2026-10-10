/**
 * The private-path rule is parsed in four files (k.js, consent.js,
 * collector.mjs, posthog-guard.mjs) so each can be copied alone. They must
 * agree, and a rule that does not parse must never silently match nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCollector, memoryStore } from '../skills/sectionsight/assets/collector.mjs';
import { isPrivate, startPostHog } from '../skills/sectionsight/assets/posthog-guard.mjs';

const dir = new URL('../skills/sectionsight/assets/', import.meta.url);
const parsers = {};
for (const f of ['k.js', 'consent.js', 'collector.mjs', 'posthog-guard.mjs']) {
  const src = await readFile(new URL(f, dir), 'utf8');
  const block = /\/\/ <toRegExp>[^\n]*\n([\s\S]*?)\/\/ <\/toRegExp>/.exec(src);
  assert.ok(block, `${f} marks its toRegExp block`);
  parsers[f] = new Function(`${block[1].replace(/\bexport /g, '')}; return toRegExps;`)();
}

// [rule, path, expected]: true/false = whether the path is private; 'throws'.
const TABLE = [
  ['^/account(/|$)', '/account/x', true],
  ['^/account(/|$)', '/Account/x', false],
  ['/^\\/account(\\/|$)/i', '/Account/x', true],
  ['/^\\/account(\\/|$)/', '/account/x', true], // slashes, no flags
  ['/^\\/account(\\/|$)/I', '/ACCOUNT', true], // upper-case flag
  ['/^\\/account(\\/|$)/gi', '/Account/x', true], // g dropped
  ['  /^\\/account(\\/|$)/i  ', '/Account/x', true], // spaces
  ['/^\\/account(\\/|$)/x', '/account', 'throws'], // unknown flag
  ['/^\\/account(\\/|$)/ii', '/account', 'throws'], // duplicate flag
  ['/^\\/account', '/account', 'throws'], // a literal without its closing slash
  ['^/(account', '/account', 'throws'], // does not compile
  ['', '/account', false], // no rule
  ['^/account, ^/reset', '/account', 'throws'], // a comma list instead of |
  ['/^\\/account/, /^\\/reset/', '/account', 'throws'],
  ['^/(account|reset)(/|$)', '/reset/x', true],
  ['^/a{1,3}$', '/aa', true], // a comma inside a quantifier is fine
];

test('the four parsers agree, and broken rules throw', () => {
  for (const [rule, path, expected] of TABLE) {
    for (const [f, toRegExps] of Object.entries(parsers)) {
      if (expected === 'throws') assert.throws(() => toRegExps(rule), `${f}: ${rule}`);
      else assert.equal(toRegExps(rule).some((re) => re.test(path)), expected, `${f}: ${rule} on ${path}`);
    }
  }
});

test('a RegExp with g keeps answering the same (no lastIndex state)', () => {
  const [re] = parsers['collector.mjs'](/^\/account/g);
  assert.equal(re.test('/account'), true);
  assert.equal(re.test('/account'), true);
});

test('collector: a broken skip throws at startup; a single string or RegExp is accepted', () => {
  assert.throws(() => createCollector({ hosts: ['example.com'], store: memoryStore(), skip: '/^\\/account/x' }));
  assert.doesNotThrow(() => createCollector({ hosts: ['example.com'], store: memoryStore(), skip: '^/account(/|$)' }));
  assert.doesNotThrow(() => createCollector({ hosts: ['example.com'], store: memoryStore(), skip: /^\/account/ }));
});

test('posthog-guard: a broken private rule makes every page private; startPostHog logs it and resolves null', async () => {
  const site = { private: ['/^\\/account'], hosts: ['example.com'], token: 't', consented: () => true };
  assert.equal(isPrivate('/pricing', site), true);
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let loaded = false;
  try {
    const p = startPostHog(site, () => ((loaded = true), Promise.resolve({})));
    assert.equal(await p, null);
  } finally {
    console.error = orig;
  }
  assert.equal(loaded, false, 'PostHog never loads');
  assert.ok(errors.some((e) => e.includes('site.private')), errors.join(' | '));
});
