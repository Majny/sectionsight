/**
 * The two opt-in modules of k.js and the collector: JavaScript errors
 * (scrubbed, totals only) and Core Web Vitals (buckets per section). Unit
 * tests; the browser tests are in browser.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createCollector, memoryStore, fileStore, mongoStore, sqlStore, analyticsEngineStore, parseBeacon,
  scrubError, errFile, errFingerprint, p75FromBuckets, CWV_BUCKETS,
} from '../skills/sectionsight/assets/collector.mjs';
import { checkHealth, addDays } from '../skills/sectionsight/assets/health.mjs';
import { enforceRetention } from '../skills/sectionsight/assets/retention.mjs';
import { fakeMongo, sqliteQuery } from './fakes.mjs';

const kjs = await readFile(new URL('../skills/sectionsight/assets/k.js', import.meta.url), 'utf8');
const blockOf = (name) => {
  const m = new RegExp(`// <${name}>[^\\n]*\\n([\\s\\S]*?)// </${name}>`).exec(kjs);
  assert.ok(m, `k.js marks its ${name} block`);
  return m[1];
};
const kScrub = new Function(`${blockOf('looksPersonal')}${blockOf('scrubError')}; return scrubError;`)();
const kCwv = new Function(`${/var CWV = [^\n]*/.exec(kjs)[0]}; return CWV;`)();

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
function req(body, headers = {}) {
  return new Request('https://example.com/api/k', {
    method: 'POST',
    headers: { origin: 'https://example.com', referer: 'https://example.com/', 'user-agent': UA, 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: JSON.stringify(body),
  });
}
const ctx = { ownHosts: ['example.com'], skip: [], ids: 'consent' };

// [message, scrubbed]
const SCRUB = [
  ["Uncaught TypeError: Cannot read properties of undefined (reading 'name')", "TypeError: Cannot read properties of undefined (reading '')"],
  ['Error: user jane.doe@example.com not found', 'Error: user <email> not found'],
  ['Failed to load https://api.example.com/v1/users/42?token=abc', 'Failed to load <url>'],
  ['Invalid invite prb7f3c9a1e5d2b8f4a6c0e9d1b3a5f7c9e', 'Invalid invite <id>'],
  ['Unexpected token < in JSON at position 1234', 'Unexpected token < in JSON at position 0'],
  ['Bad payload {"email":"a@b.cz","id":123,"name":"Jan"}', 'Bad payload {"":"","":0,"":""}'],
  ['TypeError: x is not a function\n    at render (https://example.com/app.js:10:5)\n    at https://example.com/app.js:20:1', 'TypeError: x is not a function at render (<url> at <url>'],
  ["Can't find variable: gtag", "Can't find variable: gtag"],
  ['Ungültiger Wert „Zoë Müller“ für Feld 3', 'Ungültiger Wert "" für Feld 0'],
  ['Error: fetch /u/jane-doe/profile failed', 'Error: fetch <path> failed'],
  ['Request failed with status code 500 after 3 retries', 'Request failed with status code 0 after 0 retries'],
  ['Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc expired', 'Token <id> expired'],
  ['Error: unterminated "jane@example.com and the rest', 'Error: unterminated ""'],
  ['phone +420 777 123 456 rejected', 'phone +0 0 0 0 rejected'],
  ['id 550e8400-e29b-41d4-a716-446655440000 missing', 'id <id> missing'],
  ['template `Hello ${user.name}` failed', 'template `` failed'],
  // Found by an audit: percent-escaped e-mails, relative queries, host/path without a scheme, home directories.
  ['Bad request ?email=jane%40example.com&name=Jane', 'Bad request <email>'],
  ['x jane%2540example.com', 'x <email>'],
  ['mail jane\uff20example.com', 'mail <email>'],
  ['Failed (/account?name=jane)', 'Failed (<url>'],
  ['route=/u/jane-doe?ref=mail', '<url>'],
  ['Go to x.com/reset?token=abc', 'Go to <url>'],
  ['see www.evil.com/?q=jane', 'see <url>'],
  ['open docs.example.com/guide/jane failed', 'open <url> failed'],
  // A stack frame keeps its file name and position, never the directories.
  ['at render (/Users/jane/app.js:1:2)', 'at render (<path>/app.js:0:0)'],
  // Found by a second audit: relative and Windows paths, local hosts, data: URLs, other spellings of @, UTF-8 escapes.
  ['Error: users/jane-doe.json missing', 'Error: <path> missing'],
  ['Error: ./x and ~/jane/x', 'Error: <path> and <path>'],
  ['Error: open C:\\Users\\jane.doe\\notes.txt', 'Error: open <path>'],
  ['Error: open \\\\server\\share\\jane', 'Error: open <path>'],
  ['Error: fetch localhost:3000/users/jane failed', 'Error: fetch <url> failed'],
  ['Error: fetch 0.0.0.0/users/jane failed', 'Error: fetch <url> failed'],
  ['Error: fetch [::1]:3000/users/jane failed', 'Error: fetch <url> failed'],
  ['Error: fetch m\u00fcller.de/u/jane failed', 'Error: fetch <url> failed'],
  ['Error: bad data:text/plain,Jane-Doe-secret-note', 'Error: bad <data>'],
  ['Error: user jane&#64;example.org', 'Error: user <email>'],
  ['Error: user jane\ufe6bexample.org', 'Error: user <email>'],
  ['Error: user jane"@"example.org', 'Error: user <email>'],
  ['Error: user jane @ example.org', 'Error: user <email>'],
  ['Error: user jane(at)example.org', 'Error: user <email>'],
  ['Error: load users%2Fjane-doe%2Fprofile failed', 'Error: load <path> failed'],
  ['Error: double %252Fusers%252Fjane', 'Error: double <path>'],
  ['Error: page#access_token=abcdefXYZ', 'Error: <url>'],
  ['Error: page;jsessionid=ABCDEF1234567', 'Error: <url>'],
  ['Error: account=jane.doe&x=1', 'Error: <url>'],
  ['Error: at Object.<anonymous> (webpack:///./src/users/jane.ts:1:2)', 'Error: at Object.<anonymous> (<url>'],
  ["can't parse 'jane doe", "can't parse ''"],
  // Firefox says "uncaught exception: ", Chromium and WebKit "Uncaught ": the same fingerprint.
  ['uncaught exception: Error: boom', 'Error: boom'],
  ['Uncaught Error: boom', 'Error: boom'],
  ['TypeError: a.b is not a function', 'TypeError: a.b is not a function'],
  ['', ''],
  [null, ''],
];

test('scrubError: strings, numbers, e-mails, URLs, paths and tokens go; the same in k.js and the collector', () => {
  for (const [m, want] of SCRUB) {
    assert.equal(scrubError(m), want, JSON.stringify(m));
    assert.equal(kScrub(m), want, 'k.js: ' + JSON.stringify(m));
    // Idempotent: the collector scrubs what k.js already scrubbed.
    assert.equal(scrubError(scrubError(m)), want);
  }
  const long = 'Error: ' + 'word '.repeat(400) + 'jane@example.com';
  assert.ok(scrubError(long).length <= 160);
  assert.ok(!scrubError('x'.repeat(5000) + ' jane@example.com').includes('@'));
  // An e-mail past the 1000 characters examined is cut, never kept.
  assert.ok(!scrubError('a '.repeat(498) + 'jane@example.com').includes('jane'));
});

test('scrubError runs in linear time: worst-case 4 KB messages take under 20 ms, in k.js and the collector', () => {
  const n = 4096;
  const worst = {
    question: '?'.repeat(n), questionA: '?a'.repeat(n / 2), at: '@'.repeat(n), dots: 'a.'.repeat(n / 2), dotSlash: 'a.b/'.repeat(n / 4),
    percent: '%25'.repeat(n / 3), utf8: '%C5%99'.repeat(n / 6), uEscape: '%u0040'.repeat(n / 6), entity: '&#64;'.repeat(n / 5),
    slashes: ' /'.repeat(n / 2), backslashes: '\\'.repeat(n), hyphens: 'a-'.repeat(n / 2) + '.', mix: 'a?b'.repeat(n / 3), colons: 'a:'.repeat(n / 2),
    scheme: 'a'.repeat(n - 1) + ':', quotes: '"'.repeat(n), single: " '".repeat(n / 2), escapes: '"\\'.repeat(n / 2), curly: '\u201c'.repeat(n),
    brackets: '['.repeat(n), ipv6: '[' + ':'.repeat(n - 2) + ']', ip: '1.'.repeat(n / 2), hostPort: 'a.bc:'.repeat(n / 5), semis: ';='.repeat(n / 2),
    atSpaces: ' @ '.repeat(n / 3), atWords: '(at)'.repeat(n / 4), data: 'data:'.repeat(n / 5), frame: '/a.js:1:'.repeat(n / 8), letters: 'aB3'.repeat(n / 3),
    digits: '1'.repeat(n), spaces: ' '.repeat(n),
  };
  for (const [name, m] of Object.entries(worst)) {
    for (const [who, fn] of [['collector', scrubError], ['k.js', kScrub]]) {
      const t = performance.now();
      fn(m);
      const ms = performance.now() - t;
      assert.ok(ms < 20, `${who} ${name}: ${ms.toFixed(1)} ms`);
    }
  }
});

test('errFile: a file name only, token-like parts as *, nothing else', () => {
  assert.equal(errFile('app.js'), 'app.js');
  assert.equal(errFile('(inline)'), '(inline)');
  assert.equal(errFile('page-4a2b8c1d9e0f3a5b.js'), 'page-*.js');
  assert.equal(errFile('https://example.com/app.js'), '');
  assert.equal(errFile('app.js?v=1'), '');
  assert.equal(errFile('a/b.js'), '');
  assert.equal(errFile(42), '');
  assert.equal(errFile('jane-doe'), '', 'a page name is never a file: k.js sends the page as (inline)');
  assert.equal(errFile('chunk.mjs'), 'chunk.mjs');
});

test('an err report: totals per page and fingerprint, one sample a day, never a row, even with ids', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, ids: 'consent' });
  const err = (m, l = 10, extra = {}) => req({ p: '/pricing', e: 'err', d: { m, f: 'app.js', l, c: 3, s: 'plans' }, vi: '0123456789abcdef', v: 'fedcba9876543210', en: 2, r: 'google.com', ...extra });
  // A client that did not scrub: the collector does it again.
  await collect(err('Error: user jane@example.com failed with 42'));
  await collect(err('Error: user bob@example.org failed with 7'));
  await collect(err('Error: other', 11));
  assert.equal(store.rows.length, 0, 'no row, though the report carried ids');
  const page = [...store.daily.values()].find((d) => d.path === '/pricing');
  const fp = errFingerprint('Error: user <email> failed with 0', 'app.js', 10);
  assert.match(fp, /^[0-9a-f]{8}$/);
  assert.equal(page.err[fp], 2, 'two messages, one fingerprint once scrubbed');
  assert.equal(Object.keys(page.err).length, 2);
  assert.ok(!('*' in Object.fromEntries([...store.daily].map(([k, v]) => [v.path, v]))), 'an err report never adds a visit or an entry');
  const samples = await store.errSamples([...store.daily.values()][0].day);
  assert.deepEqual(samples[fp], { m: 'Error: user <email> failed with 0', f: 'app.js', l: 10, c: 3, path: '/pricing' });
  assert.ok(!JSON.stringify(samples).includes('@') && !JSON.stringify(samples).includes('0123456789abcdef'));
  // Stable: the same scrubbed error gets the same fingerprint, a new line another.
  assert.equal(errFingerprint('Error: user <email> failed with 0', 'app.js', 10), fp);
  assert.notEqual(errFingerprint('Error: user <email> failed with 0', 'app.js', 11), fp);
  // Dropped: no file (a cross-origin or eval'd script), a file with a path, no message.
  for (const d of [{ m: 'x', f: '' }, { m: 'x', f: 'https://cdn.example.net/x.js' }, { m: '', f: 'app.js' }]) {
    assert.equal(parseBeacon(JSON.stringify({ p: '/', e: 'err', d }), ctx), null, JSON.stringify(d));
  }
  const b = parseBeacon(JSON.stringify({ p: '/', e: 'err', d: { m: 'x', f: 'app.js' }, vi: '0123456789abcdef', v: 'fedcba9876543210', en: 2 }), ctx);
  assert.equal(b.ids, undefined);
  assert.equal(b.entry, undefined);
});

test('err: 50 fingerprints a day, then err.(other) and no more samples', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  for (let i = 0; i < 55; i++) await collect(req({ p: '/', e: 'err', d: { m: `Error: case ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}`, f: 'app.js', l: 1 } }));
  const page = [...store.daily.values()].find((d) => d.path === '/');
  assert.equal(Object.keys(page.err).length, 51);
  assert.equal(page.err['(other)'], 5);
  assert.equal(Object.keys(await store.errSamples(page.day)).length, 50);
});

test('err samples in every store: files, Mongo, SQLite; Analytics Engine keeps the counters only; retention removes samples with the rows', async () => {
  const report = { p: '/', e: 'err', d: { m: 'Error: boom 1', f: 'app.js', l: 5, c: 2, s: '' } };
  const second = { p: '/pricing', e: 'err', d: { m: 'Error: boom 2', f: 'app.js', l: 5, c: 9, s: '' } }; // same fingerprint once scrubbed
  const fp = errFingerprint('Error: boom 0', 'app.js', 5);
  const want = { m: 'Error: boom 0', f: 'app.js', l: 5, c: 2, path: '/' };
  const dir = await mkdtemp(path.join(tmpdir(), 'pfa-errs-'));
  const mongo = fakeMongo();
  const sqlite = await sqliteQuery();
  const stores = { files: fileStore(dir), mongo: mongoStore(mongo.db) };
  if (sqlite) {
    stores.sqlite = sqlStore({ dialect: 'sqlite', query: sqlite.query });
    await stores.sqlite.init();
  }
  for (const [name, store] of Object.entries(stores)) {
    // Two collectors (two processes): the store keeps the first sample.
    for (const r of [report, second]) await createCollector({ hosts: ['example.com'], store })(req(r));
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    const totals = await store.totals(day);
    assert.equal(totals[`${day} /`].err[fp], 1, name);
    assert.equal(totals[`${day} /pricing`].err[fp], 1, name);
    assert.deepEqual((await store.errSamples(day))[fp], want, name);
    await enforceRetention({ store, totalsDays: 730, rowsDays: 1, now: new Date(Date.now() + 3 * 86_400_000) });
    assert.deepEqual(await store.errSamples(day), {}, `${name}: samples follow the rows' retention`);
  }
  const points = [];
  const ae = analyticsEngineStore({ writeDataPoint: (p) => points.push(p) });
  await createCollector({ hosts: ['example.com'], store: ae })(req(report));
  assert.ok(points.some((p) => p.blobs[2] === `err.${fp}`), 'the counter is a data point');
  assert.ok(!points.some((p) => JSON.stringify(p).includes('boom')), 'no sample on Analytics Engine');
});

test('the vitals buckets are the same in k.js and the collector', () => {
  for (const [m, spec] of Object.entries(CWV_BUCKETS)) assert.deepEqual(kCwv[m], spec.edges, m);
  assert.deepEqual(Object.keys(kCwv), Object.keys(CWV_BUCKETS));
});

test('p75FromBuckets: the bucket the 75th percentile falls in, and its rating', () => {
  assert.equal(p75FromBuckets({}, 'lcp'), null);
  assert.deepEqual(p75FromBuckets({ 0: 10, 2: 10, 3: 10, 5: 10 }, 'lcp'), { bucket: 3, from: 2500, to: 3000, rating: 'needs-improvement', n: 40 });
  assert.deepEqual(p75FromBuckets([8, 1, 1], 'inp'), { bucket: 0, from: 0, to: 100, rating: 'good', n: 10 });
  assert.deepEqual(p75FromBuckets({ 4: 3, 0: 1 }, 'cls'), { bucket: 4, from: 0.25, to: Infinity, rating: 'poor', n: 4 });
  assert.equal(p75FromBuckets({ 4: 1 }, 'ttfb').rating, 'poor');
  assert.equal(p75FromBuckets({ 3: 1 }, 'ttfb').rating, 'needs-improvement');
  assert.deepEqual(p75FromBuckets({ 0: 1, 1: 3 }, null, [0, 10]), { bucket: 1, from: 10, to: Infinity, rating: undefined, n: 4 });
  assert.throws(() => p75FromBuckets({}, 'fid'));
});

test('vitals on a time report: a histogram per page and device, sections for poor LCP and INP only, never in a row', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, ids: 'consent' });
  const ids = { vi: '0123456789abcdef', v: 'fedcba9876543210' };
  await collect(req({ p: '/', e: 'time', d: { sec: 3, vis: 3, cv: { lcp: 5, lcps: 'hero', cls: 1, inp: 4, inps: 'signup-form', ttfb: 0 } }, ...ids }));
  await collect(req({ p: '/', e: 'time', d: { sec: 3, vis: 3, cv: { lcp: 2, lcps: 'hero', inp: 1, inps: 'faq' } } }, { 'user-agent': MOBILE_UA }));
  // Out of range, not an integer, a selector or text for the section: dropped.
  await collect(req({ p: '/', e: 'time', d: { sec: 1, vis: 1, cv: { lcp: 7, cls: 1.5, inp: 5, inps: 'button#buy.primary', ttfb: -1 } } }));
  const page = [...store.daily.values()].find((d) => d.path === '/');
  assert.deepEqual(page.cwv.desktop, { lcp: { 5: 1 }, cls: { 1: 1 }, inp: { 4: 1, 5: 1 }, ttfb: { 0: 1 } });
  assert.deepEqual(page.cwv.mobile, { lcp: { 2: 1 }, inp: { 1: 1 } });
  assert.deepEqual(page.cwvs, { lcp: { hero: 1 }, inp: { 'signup-form': 1, _: 1 } });
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].d.cv, undefined, 'the row has the time, not the vitals');
  assert.ok(!JSON.stringify(store.rows).includes('cwv'));
});

test('health: a new JavaScript error alerts with its sample; a usual one does not; a spike does', async () => {
  const store = memoryStore();
  const today = '2026-10-09';
  const fpNew = 'aaaa0001';
  const fpOld = 'bbbb0002';
  const doc = (day, err) => ({ _id: `${day} /`, day, path: '/', err });
  for (let i = 1; i <= 28; i++) store.daily.set(`${addDays(today, -i)} /`, doc(addDays(today, -i), { [fpOld]: 4 }));
  store.daily.set(`${today} /`, doc(today, { [fpNew]: 7, [fpOld]: 5 }));
  store.daily.set(`${today} /pricing`, { _id: `${today} /pricing`, day: today, path: '/pricing', err: { [fpNew]: 1 } });
  store.errs.set(today, { [fpNew]: { m: 'TypeError: <*> is not a function', f: 'app.js', l: 42, c: 1, path: '/pricing' } });
  const now = new Date(`${today}T12:00:00Z`);
  const run = (state) => checkHealth({ store, now, state, rules: { silence: false, low: false, goal: false, writes: false, notFound: false } });
  const r = await run(null);
  assert.deepEqual(r.alerts.map((a) => a.rule), [`errors:${fpNew}`]);
  // By default the error is named by fingerprint, file and line, never its message.
  assert.match(r.alerts[0].text, /New JavaScript error, 8 today: error aaaa0001 · app\.js:42 · first on \/pricing/);
  assert.ok(!r.alerts[0].text.includes('TypeError'));
  const shown = await checkHealth({ store, now, showErrorText: true, rules: { silence: false, low: false, goal: false, writes: false, notFound: false } });
  assert.match(shown.alerts[0].text, /New JavaScript error, 8 today: TypeError: <\*> is not a function · app\.js:42 · first on \/pricing/);
  // A spike of the old one: 5× its usual day.
  store.daily.set(`${today} /`, doc(today, { [fpNew]: 8, [fpOld]: 25 }));
  const r2 = await run(r.state);
  assert.deepEqual(r2.alerts.map((a) => a.rule), [`errors:${fpOld}`]);
  assert.match(r2.alerts[0].text, /25 times today, a whole Friday usually has 4: error bbbb0002 \(no sample kept\)/);
  // The next day the new one is no longer new, and below the spike threshold: recovered.
  const next = '2026-10-10';
  store.daily.set(`${next} /`, doc(next, { [fpNew]: 3, [fpOld]: 4 }));
  const r3 = await checkHealth({ store, now: new Date(`${next}T12:00:00Z`), state: r2.state, rules: { silence: false, low: false, goal: false, writes: false, notFound: false } });
  assert.deepEqual(r3.recovered.map((x) => x.rule).sort(), [`errors:${fpNew}`, `errors:${fpOld}`]);
});

test('health: a first-ever err.(other) flood alerts; a spike over a usual day of none says so', async () => {
  const store = memoryStore();
  const today = '2026-10-09';
  const doc = (day, err) => ({ _id: `${day} /`, day, path: '/', err });
  // cccc0003 was seen 8 days ago only: its usual Friday has none.
  store.daily.set(`${addDays(today, -8)} /`, doc(addDays(today, -8), { cccc0003: 1 }));
  store.daily.set(`${today} /`, doc(today, { '(other)': 40, cccc0003: 30 }));
  const r = await checkHealth({ store, now: new Date(`${today}T12:00:00Z`), rules: { silence: false, low: false, goal: false, writes: false, notFound: false } });
  const by = Object.fromEntries(r.alerts.map((a) => [a.rule, a.text]));
  assert.match(by['errors:(other)'], /A flood of JavaScript errors: 40 today past the daily cap of distinct errors/);
  assert.match(by['errors:cccc0003'], /30 times today, unusual for a Friday \(seen in the 28 days before, but its Friday median is 0\)/);
  assert.ok(!/usually has 0/.test(JSON.stringify(by)));
});

test('errFile in k.js and the collector: a decoded name that looks personal is "(hidden)", a hash is *', () => {
  const src = /\n {2}function errFile\(src\) \{[\s\S]*?\n {2}\}\n/.exec(kjs);
  assert.ok(src, 'k.js errFile');
  const kErrFile = new Function('location', `${blockOf('looksPersonal')}${src[0]}; return errFile;`)({ href: 'https://example.com/', origin: 'https://example.com' });
  assert.equal(kErrFile('https://example.com/static/chunk-jane.doe%40example.com.js'), '(hidden)');
  assert.equal(kErrFile('https://example.com/static/chunk-jane.doe\uff20example.com.js'), '(hidden)');
  assert.equal(kErrFile('https://example.com/static/chunk-a8f3e9c1d2b4f7e6.js?v=2'), 'chunk-*.js');
  // Build hashes of Vite, webpack and Next.js are starred, never hidden.
  for (const [name, want] of [['index-BXk3aF9q.js', 'index-*.js'], ['chunk-9f8e7d6c.js', 'chunk-*.js'], ['app-a1b2c3d4.js', 'app-*.js'], ['main-app-9f2c.js', 'main-app-9f2c.js'], ['main.4f2a9c1b.js', 'main.*.js'], ['framework-64ad27b21261a9ce.js', 'framework-*.js'], ['index.js', 'index.js']]) {
    assert.equal(kErrFile('https://example.com/assets/' + name), want, 'k.js ' + name);
    assert.equal(errFile(name), want, 'collector ' + name);
  }
  assert.equal(kErrFile('https://example.com/'), '(inline)');
  assert.equal(kErrFile('https://cdn.example.net/app.js'), '');
  assert.equal(errFile('(hidden)'), '(hidden)');
  assert.equal(errFile('chunk-a8f3e9c1d2b4f7e6.js'), 'chunk-*.js');
  assert.equal(errFile('jane.doe@example.com.js'), '', 'not a bare file name');
});
