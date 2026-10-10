import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, memoryStore, parseBeacon, dailyIncs, eventRow, pagePath, sourceOf, shortIp, visitorOf, looksPersonal, dailyIds } from '../skills/sectionsight/assets/collector.mjs';

const ctx = { ownHosts: ['example.com'], skip: [/^\/account(\/|$)/], ids: 'consent' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function req(body, headers = {}) {
  return new Request('https://example.com/api/k', {
    method: 'POST',
    headers: { origin: 'https://example.com', referer: 'https://example.com/', 'user-agent': UA, 'content-type': 'text/plain;charset=UTF-8', 'cf-ipcountry': 'CZ', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('a page view with its entry: counted in the totals, no row without ids', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  const res = await collect(req({ p: '/', d: { of: 3 }, en: 1, r: 'www.google.com', u: { source: 'newsletter' }, l: 'cs-CZ' }));
  assert.equal(res.status, 204);
  const day = [...store.daily.values()];
  const page = day.find((d) => d.path === '/');
  const visits = day.find((d) => d.path === '*');
  assert.equal(page.views, 1);
  assert.equal(visits.visits, 1);
  assert.equal(visits.src.newsletter, 1, 'a known utm_source wins over the referrer');
  assert.equal(visits.geo.cz, 1);
  assert.equal(visits.dev.desktop, 1);
  assert.equal(store.rows.length, 0);
});

test('ids only with consent mode: a report with vi and v becomes a row with the entry', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  await collect(req({ p: '/pricing', en: 1, r: '', u: {}, l: 'en', vi: '0123456789abcdef', v: 'fedcba9876543210', ph: '0199aa00-1111-7222-8333-944445555666' }));
  assert.equal(store.rows.length, 1);
  const row = store.rows[0];
  assert.equal(row.visit, '0123456789abcdef');
  assert.equal(row.path, '/pricing');
  assert.equal(row.entry.source, 'direct');
  assert.equal(row.entry.country, 'cz');
  assert.equal(row.replay, '0199aa00-1111-7222-8333-944445555666');
});

test('dropped: other origins, bots, GPC, DNT, oversize, junk and private paths', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, skip: [/^\/account(\/|$)/] });
  const ok = { p: '/' };
  for (const r of [
    req(ok, { origin: 'https://evil.example' }),
    req(ok, { 'user-agent': 'Mozilla/5.0 HeadlessChrome/140' }),
    req(ok, { 'user-agent': 'Googlebot/2.1' }),
    req(ok, { 'sec-gpc': '1' }),
    req(ok, { dnt: '1' }),
    req('x'.repeat(5000)),
    req('{not json'),
    req({ p: '/', e: 'nope' }),
    req({ p: 'https://example.com/' }),
    req({ p: '/account/42' }),
  ]) {
    assert.equal((await collect(r)).status, 204);
  }
  assert.equal(store.daily.size, 0);
  assert.equal((await collect(new Request('https://example.com/api/k'))).status, 405);
});

test('paths: token-like segments, e-mails and private paths never count', () => {
  assert.equal(pagePath('/blog/how-to-measure'), '/blog/how-to-measure');
  assert.equal(pagePath('/orders/[id]'), '/orders/[id]');
  assert.equal(pagePath('/reset/9f8e7d6c5b4a32100123abcd'), null);
  assert.equal(pagePath('/u/jane@example.com'), null);
  assert.equal(pagePath('/u/jane%40example.com'), null);
  assert.equal(pagePath('/call/420123456789'), null);
  assert.equal(pagePath('/account', [/^\/account(\/|$)/]), null);
  assert.equal(pagePath('/pricing/'), '/pricing');
  assert.equal(pagePath('/a?b=c'), null);
});

test('utm values that may name someone are dropped; unknown sources are reduced to their site', () => {
  const b = parseBeacon(JSON.stringify({ p: '/', en: 1, r: 'jane-doe.github.io', u: { source: 'jane.doe@example.com', campaign: 'spring-2026' } }), ctx);
  assert.equal(b.entry.utm.source, undefined);
  assert.equal(b.entry.utm.campaign, 'spring-2026');
  assert.equal(b.entry.source, 'github.io', 'the platform, not the person');
  assert.equal(sourceOf('docs.acme.sharepoint.com', ['example.com']), 'sharepoint.com');
  assert.equal(sourceOf('www.example.com', ['example.com']), 'internal');
  assert.equal(sourceOf('com.google.android.gm', ['example.com']), 'gmail');
});

test('events are cut down to their fields; labels that look personal lose their text', () => {
  const dead = parseBeacon(JSON.stringify({ p: '/', e: 'dead', d: { s: 'faq', label: 'strong:jane@example.com', extra: 'x' } }), ctx);
  assert.deepEqual(dead.data, { s: 'faq', label: 'strong' });
  const time = parseBeacon(JSON.stringify({ p: '/', e: 'time', d: { sec: 5, vis: 9, secs: [['intro', 99], ['BAD KEY', 2]], dn: [25, 33, 50], hb: [0, 1] } }), ctx);
  assert.deepEqual(time.data.secs, [['intro', 5]], 'a section cannot have more seconds than the report');
  assert.deepEqual(time.data.dn, [25, 50]);
  assert.deepEqual(time.data.hb, [0, 1]);
  const mail = parseBeacon(JSON.stringify({ p: '/', e: 'cta', d: { k: 'email', url: 'mailto:jane@example.com', s: 'contact' } }), ctx);
  assert.equal(mail.data.url, undefined, 'never the address of an e-mail link');
  const out = parseBeacon(JSON.stringify({ p: '/', e: 'cta', d: { k: 'outbound', url: 'github.com/acme/repo' } }), ctx);
  assert.equal(out.data.url, 'github.com/acme/repo');
  const tok = parseBeacon(JSON.stringify({ p: '/', e: 'cta', d: { k: 'outbound', url: 'example.org/reset/9f8e7d6c5b4a32100123abcd' } }), ctx);
  assert.equal(tok.data.url, undefined);
});

test('the histogram moves a visit between buckets without knowing which visit it is', () => {
  const admit = () => true;
  const b = parseBeacon(JSON.stringify({ p: '/', e: 'time', d: { sec: 12, vis: 12, secs: [], dn: [], hb: [0, 2] } }), ctx);
  const incs = dailyIncs(b, { country: 'cz', device: 'mobile' }, '2026-10-05', admit);
  const visit = incs.find((u) => u.path === '*');
  assert.deepEqual(visit.inc, { 'hist.0': -1, 'hist.2': 1 });
});

test('a repeated entry (consent given mid-visit) fills the row but is not counted again', () => {
  const b = parseBeacon(JSON.stringify({ p: '/', e: 'read', d: { s: 'intro' }, en: 2, r: 'google.com', u: {}, l: 'en', vi: '0123456789abcdef', v: 'fedcba9876543210' }), ctx);
  assert.equal(b.entryRepeat, true);
  const incs = dailyIncs(b, { country: 'cz', device: 'mobile' }, '2026-10-05', () => true);
  assert.equal(incs.find((u) => u.path === '*'), undefined);
  const row = eventRow(b, { country: 'cz', device: 'mobile' }, '2026-10-05', new Date());
  assert.equal(row.entry.source, 'google');
});

test("'always' mode: the visitor is a daily hash, the view id is hashed with the day", async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, ids: 'always', secret: 's3cret' });
  await collect(req({ p: '/', v: 'fedcba9876543210', vi: '0123456789abcdef' }));
  await collect(req({ p: '/', e: 'read', d: { s: 'intro' }, v: 'fedcba9876543210' }));
  assert.equal(store.rows.length, 2);
  assert.match(store.rows[0].visit, /^[0-9a-f]{16}$/);
  assert.notEqual(store.rows[0].visit, '0123456789abcdef', 'the browser visit id is ignored in this mode');
  assert.equal(store.rows[0].visit, store.rows[1].visit);
  assert.notEqual(store.rows[0].view, 'fedcba9876543210');
  const a = await dailyIds('s3cret', '2026-10-05', '203.0.113.7', UA, 'v1');
  const b = await dailyIds('s3cret', '2026-10-06', '203.0.113.7', UA, 'v1');
  const c = await dailyIds('s3cret', '2026-10-05', '203.0.113.99', UA, 'v1');
  assert.notEqual(a.visitor, b.visitor, 'days cannot be linked');
  assert.equal(a.visitor, c.visitor, 'the same /24 on the same day is the same visitor');
  assert.throws(() => createCollector({ hosts: ['example.com'], store, ids: 'always' }));
});

test('helpers', () => {
  assert.equal(shortIp('203.0.113.7'), '203.0.113.0');
  assert.equal(shortIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8:85a3::');
  assert.equal(shortIp('::ffff:198.51.100.4'), '198.51.100.0');
  assert.equal(looksPersonal('spring-2026'), false);
  assert.equal(looksPersonal('+420 123 456 789'), true);
  assert.equal(looksPersonal('550e8400-e29b-41d4-a716-446655440000'), true);
  const h = new Headers({ 'user-agent': UA, 'x-vercel-ip-country': 'DE' });
  assert.deepEqual(visitorOf(h), { country: 'de', device: 'desktop' });
});

test('a flood from one address is throttled', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  for (let i = 0; i < 160; i++) await collect(req({ p: '/' }));
  assert.equal(store.daily.get([...store.daily.keys()].find((k) => k.endsWith(' /'))).views, 150);
});

import http from 'node:http';
import net from 'node:net';
import { toNodeHandler, defaultClientIp, fileStore, analyticsEngineStore } from '../skills/sectionsight/assets/collector.mjs';

test('the Node adapter survives an aborted upload and a malformed Host header', async () => {
  const store = memoryStore();
  const server = http.createServer(toNodeHandler(createCollector({ hosts: ['example.com'], store })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const raw = (text, destroy) =>
    new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(text);
        if (destroy) setTimeout(() => sock.destroy(), 50);
      });
      sock.on('data', () => sock.destroy());
      sock.on('close', resolve);
      sock.on('error', resolve);
    });
  await raw('POST /api/k HTTP/1.1\r\nHost: example.com:99999\r\nOrigin: https://example.com\r\nUser-Agent: Mozilla/5.0 Chrome/140\r\nContent-Length: 12\r\n\r\n{"p":"/"}   ');
  await raw('POST /api/k HTTP/1.1\r\nHost: example.com\r\nContent-Length: 500\r\n\r\n{"p":"/', true);
  await new Promise((r) => setTimeout(r, 100));
  const res = await fetch(`http://127.0.0.1:${port}/api/k`, { method: 'GET' });
  assert.equal(res.status, 405, 'still serving');
  await new Promise((r) => server.close(r));
});

test('no key from the browser can reach Object.prototype or a global', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  await collect(req({ p: '/', e: 'read', d: { s: 'constructor' } }));
  await collect(req({ p: '/', e: 'read', d: { s: 'prototype' } }));
  assert.equal(Object.r, undefined);
  assert.equal(({}).r, undefined);
});

test('the default client IP is the last X-Forwarded-For entry, never the first', () => {
  const r = (h) => new Request('https://example.com/api/k', { headers: h });
  assert.equal(defaultClientIp(r({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })), '203.0.113.7');
  assert.equal(defaultClientIp(r({ 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '6.6.6.6' })), '198.51.100.1');
});

test('utm campaigns stay out of the two-year totals; rows keep them', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  await collect(req({ p: '/', en: 1, r: '', u: { source: 'newsletter', campaign: 'jane-doe-offer' }, l: 'en', vi: '0123456789abcdef', v: 'fedcba9876543210' }));
  const visits = [...store.daily.values()].find((d) => d.path === '*');
  assert.equal(JSON.stringify(visits).includes('jane-doe'), false);
  assert.equal(store.rows[0].entry.utm.campaign, 'jane-doe-offer');
});

test('section keys and anchors that look personal are dropped', () => {
  const b = parseBeacon(JSON.stringify({ p: '/', e: 'cta', d: { k: 'nav', url: '/welcome#u-9f8e7d6c5b4a32100123abcd', s: 'call-420-777-123-456' } }), ctx);
  assert.equal(b.data.url, '/welcome');
  assert.equal(b.data.s, '');
});

test('fileStore keeps totals and rows in files and purges by age', async () => {
  const { mkdtemp, writeFile, mkdir, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(tmpdir() + '/sectionsight-fs-');
  const store = fileStore(dir);
  const collect = createCollector({ hosts: ['example.com'], store, timeZone: 'UTC' });
  await Promise.all([collect(req({ p: '/', en: 1, r: '', u: {}, l: 'en' })), collect(req({ p: '/', e: 'read', d: { s: 'intro' }, vi: '0123456789abcdef', v: 'fedcba9876543210' }))]);
  const day = new Date().toISOString().slice(0, 10);
  const daily = await store.daily(day);
  assert.equal(daily[`${day} /`].views, 1);
  assert.equal((await store.rows(day)).length, 1);
  await mkdir(dir + '/rows', { recursive: true });
  await writeFile(dir + '/rows/2020-01-01.jsonl', '{}\n');
  assert.equal(await store.purge(), 1);
  assert.deepEqual(await readdir(dir + '/rows'), [`${day}.jsonl`]);
});

test('analyticsEngineStore writes one data point per counter and one per row', async () => {
  const points = [];
  const collect = createCollector({ hosts: ['example.com'], store: analyticsEngineStore({ writeDataPoint: (p) => points.push(p) }) });
  await collect(req({ p: '/', en: 1, r: '', u: {}, l: 'en', vi: '0123456789abcdef', v: 'fedcba9876543210' }));
  const counters = points.filter((p) => p.blobs.length === 3);
  const sum = (key) => counters.filter((p) => p.blobs[2] === key).reduce((n, p) => n + p.doubles[0], 0);
  assert.equal(sum('views'), 1);
  assert.equal(sum('visits'), 1);
  assert.equal(points.filter((p) => p.indexes[0] === '0123456789abcdef').length, 1, 'one row');
});

test('names from the page (data-kcta, data-kgoal, data-kui) that look personal are dropped', () => {
  assert.equal(parseBeacon(JSON.stringify({ p: '/', e: 'goal', d: { k: 'k3j5h2g7f8d9s0a1' } }), ctx), null);
  assert.equal(parseBeacon(JSON.stringify({ p: '/', e: 'ui', d: { k: 'faq:420777123456' } }), ctx), null);
  assert.equal(parseBeacon(JSON.stringify({ p: '/', e: 'cta', d: { k: 'k3j5h2g7f8d9s0a1' } }), ctx), null);
  assert.equal(parseBeacon(JSON.stringify({ p: '/', e: 'goal', d: { k: 'signup' } }), ctx).data.k, 'signup');
});

test('campaignTotals false: a utm_source stays out of the totals, rows keep it', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, campaignTotals: false });
  await collect(req({ p: '/', en: 1, r: 'www.google.com', u: { source: 'newsletter' }, l: 'en', vi: '0123456789abcdef', v: 'fedcba9876543210' }));
  const visits = [...store.daily.values()].find((d) => d.path === '*');
  assert.deepEqual(visits.src, { google: 1 });
  assert.equal(store.rows[0].entry.source, 'newsletter');
});

test('skip: a string is one regex, "/source/i" with flags', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, skip: ['/^\\/account(\\/|$)/i', '^/reset(/|$)'] });
  for (const p of ['/Account/settings', '/ACCOUNT', '/reset/x']) await collect(req({ p }));
  assert.equal(store.daily.size, 0);
  await collect(req({ p: '/Reset/x' }));
  assert.equal(store.daily.size, 1, 'no flag: case-sensitive');
});

test('umamiForwarder: the last X-Forwarded-For entry, shortened, or what clientIp says', async () => {
  const { umamiForwarder } = await import('../skills/sectionsight/assets/collector.mjs');
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => (sent.push(JSON.parse(init.body).payload.ip), new Response(null));
  try {
    const b = { event: 'view', path: '/', entry: { source: 'direct', lang: 'en' } };
    const r = new Request('https://example.com/api/k', { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7', 'user-agent': UA } });
    await umamiForwarder({ websiteId: 'w', hostname: 'example.com' })(b, {}, r);
    await umamiForwarder({ websiteId: 'w', hostname: 'example.com', clientIp: () => '198.51.100.9' })(b, {}, r);
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(sent, ['203.0.113.0', '198.51.100.0']);
});

test('X-Real-IP is never trusted by default: a client cannot pick its IP through it', async () => {
  const r = (h) => new Request('https://example.com/api/k', { headers: h });
  assert.equal(defaultClientIp(r({ 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })), '203.0.113.7');
  assert.equal(defaultClientIp(r({ 'x-real-ip': '6.6.6.6' })), '');
  // Behind a proxy (trustProxy: true) that passes the client's X-Real-IP through.
  const seen = [];
  const server = http.createServer(toNodeHandler(async (request) => (seen.push(defaultClientIp(request)), new Response(null, { status: 204 })), { trustProxy: true }));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/api/k`, { method: 'POST', body: '{}', headers: { 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } });
    await fetch(`http://127.0.0.1:${server.address().port}/api/k`, { method: 'POST', body: '{}', headers: { 'x-real-ip': '6.6.6.6' } });
  } finally {
    await new Promise((res) => server.close(res));
  }
  assert.deepEqual(seen, ['203.0.113.7', '']);
});

// --- 404 pages (k.js data-k404) ------------------------------------------------------
import { nfKey, mongoStore } from '../skills/sectionsight/assets/collector.mjs';

test('nf: the referrer kind is kept, anything else becomes none; a personal path is dropped', () => {
  assert.deepEqual(parseBeacon(JSON.stringify({ p: '/old-page', e: 'nf', d: { r: 'internal' } }), ctx).data, { r: 'internal' });
  assert.deepEqual(parseBeacon(JSON.stringify({ p: '/old-page', e: 'nf', d: { r: 'https://evil.example/' } }), ctx).data, { r: 'none' });
  assert.deepEqual(parseBeacon(JSON.stringify({ p: '/old-page', e: 'nf' }), ctx).data, { r: 'none' });
  assert.equal(parseBeacon(JSON.stringify({ p: '/u/jane@example.com', e: 'nf', d: { r: 'none' } }), ctx), null);
  assert.equal(parseBeacon(JSON.stringify({ p: '/reset/Pq7xK2mZ9_wR4tY-8sLnB', e: 'nf', d: { r: 'none' } }), ctx), null);
  assert.equal(parseBeacon(JSON.stringify({ p: '/account/x', e: 'nf', d: { r: 'none' } }), ctx), null, 'private paths stay out');
  assert.ok(parseBeacon(JSON.stringify({ p: '/reset/[id]', e: 'nf', d: { r: 'external' } }), ctx), 'a cleaned [id] segment is fine');
});

test('nf: nf.<path> counts every 404, nfin.<path> those linked from the site; "." is written %2E', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  await collect(req({ p: '/old-page', e: 'nf', d: { r: 'internal' } }));
  await collect(req({ p: '/old-page', e: 'nf', d: { r: 'external' } }));
  await collect(req({ p: '/docs/v1.2', e: 'nf', d: { r: 'none' } }));
  const day = [...store.daily.values()].find((d) => d.path === '*');
  assert.deepEqual(day.nf, { '/old-page': 2, '/docs/v1%2E2': 1 });
  assert.deepEqual(day.nfin, { '/old-page': 1 });
  assert.equal(nfKey('/a.b.c'), '/a%2Eb%2Ec');
  // "internal" needs a same-site Referer on the request itself, or it is an ordinary 404.
  await collect(req({ p: '/forged', e: 'nf', d: { r: 'internal' } }, { referer: '' }));
  await collect(req({ p: '/forged', e: 'nf', d: { r: 'internal' } }, { referer: 'https://evil.example/x' }));
  const after = [...store.daily.values()].find((d) => d.path === '*');
  assert.equal(after.nf['/forged'], 2);
  assert.equal(after.nfin['/forged'], undefined);
  assert.equal(store.rows.length, 0, 'no ids, no row');
});

test('nf: at most 100 distinct 404 paths a day, then nf.(other)', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  for (let i = 0; i < 105; i++) await collect(req({ p: `/missing-${i}`, e: 'nf', d: { r: 'internal' } }, { 'cf-connecting-ip': `203.0.113.${i % 50}` }));
  const day = [...store.daily.values()].find((d) => d.path === '*');
  assert.equal(Object.keys(day.nf).length, 101);
  assert.equal(day.nf['(other)'], 5);
  assert.equal(day.nfin['(other)'], 5);
});

test('nf counters reach every store the same way: files, Analytics Engine, Mongo', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const fs = fileStore(await mkdtemp(tmpdir() + '/sectionsight-nf-'));
  await createCollector({ hosts: ['example.com'], store: fs, timeZone: 'UTC' })(req({ p: '/old.html', e: 'nf', d: { r: 'internal' } }));
  const day = new Date().toISOString().slice(0, 10);
  const doc = (await fs.daily(day))[`${day} *`];
  assert.deepEqual([doc.nf, doc.nfin], [{ '/old%2Ehtml': 1 }, { '/old%2Ehtml': 1 }]);

  const points = [];
  await createCollector({ hosts: ['example.com'], store: analyticsEngineStore({ writeDataPoint: (p) => points.push(p) }) })(req({ p: '/old.html', e: 'nf', d: { r: 'internal' } }));
  assert.deepEqual(points.map((p) => p.blobs[2]).sort(), ['nf./old%2Ehtml', 'nfin./old%2Ehtml']);

  const ops = [];
  const db = { collection: () => ({ updateOne: async (...a) => ops.push(a), insertOne: async () => {} }) };
  await createCollector({ hosts: ['example.com'], store: mongoStore(db) })(req({ p: '/old.html', e: 'nf', d: { r: 'external' } }));
  assert.deepEqual(ops[0][1].$inc, { 'nf./old%2Ehtml': 1 }, 'one dot: a nested counter, the path in one key');
});
