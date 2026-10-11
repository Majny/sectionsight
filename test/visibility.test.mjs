/**
 * Module 8, AI visibility: LLM referrers and utm_source values (collector.mjs),
 * AI crawlers (crawlers.mjs, crawlers-list.mjs, scripts/update-crawlers.mjs)
 * and Search Console (gsc.mjs), each into the weekly digest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  createCollector, memoryStore, mongoStore, sqlStore, sourceOf, sourceClass, parseBeacon, AI_SOURCES,
} from '../skills/sectionsight/assets/collector.mjs';
import { crawlerOf, countCrawler, crawlerTotals, statusClass, CRAWLERS, CRAWLERS_SNAPSHOT, NOT_IN_USER_AGENTS } from '../skills/sectionsight/assets/crawlers.mjs';
import { signJwt, gscDaily, gscQuery, queryUrl, gscDoc, GSC_SCOPE } from '../skills/sectionsight/assets/gsc.mjs';
import { compact, purposeOf, operatorOf } from '../skills/sectionsight/scripts/update-crawlers.mjs';
import { weeklyDigest } from '../skills/sectionsight/assets/digest.mjs';
import { enforceRetention } from '../skills/sectionsight/assets/retention.mjs';
import { addDays } from '../skills/sectionsight/assets/health.mjs';
import { fakeFetch, fakeMongo, sqliteQuery } from './fakes.mjs';

const own = ['example.com'];

test('LLM referrers and utm_source values: one key per assistant, one class "ai"', () => {
  const hosts = [
    ['chatgpt.com', 'chatgpt'], ['chat.openai.com', 'chatgpt'], ['www.perplexity.ai', 'perplexity'], ['perplexity.com', 'perplexity'], ['pplx.ai', 'perplexity'],
    ['claude.ai', 'claude'], ['gemini.google.com', 'gemini'], ['copilot.microsoft.com', 'copilot'], ['chat.deepseek.com', 'deepseek'],
    ['grok.com', 'grok'], ['www.meta.ai', 'meta-ai'], ['chat.mistral.ai', 'mistral'], ['you.com', 'you'],
    ['www.google.com', 'google'], ['www.google.co.uk', 'google'], ['www.bing.com', 'bing'], ['com.openai.chatgpt', 'chatgpt'],
    ['ai.perplexity.app.android', 'perplexity'], ['com.google.android.apps.bard', 'gemini'], ['com.deepseek.chat', 'deepseek'],
    ['com.microsoft.copilot', 'app'], ['ai.acme.example', 'acme.example'],
    ['notperplexity.ai', 'notperplexity.ai'], ['chatgpt.com.evil.example', 'evil.example'],
  ];
  for (const [h, want] of hosts) assert.equal(sourceOf(h, own), want, h);
  for (const k of AI_SOURCES) assert.equal(sourceClass(k), 'ai', k);
  const entry = (source, r = '') => parseBeacon(JSON.stringify({ p: '/', en: 1, r, u: { source }, l: 'en', d: { of: 1 } }), { ownHosts: own, skip: [], ids: 'never' }).entry.source;
  for (const [u, want] of [['chatgpt.com', 'chatgpt'], ['ChatGPT.com', 'chatgpt'], ['perplexity', 'perplexity'], ['claude.ai', 'claude'], ['copilot', 'copilot'], ['grok.com', 'grok'], ['meta.ai', 'meta-ai'], ['chatgpt.com.evil', 'direct']]) {
    assert.equal(entry(u), want, u);
  }
  // A known utm_source wins over the referrer; an unknown one never becomes a source.
  assert.equal(entry('chatgpt.com', 'www.bing.com'), 'chatgpt');
  assert.equal(entry('jane-doe-campaign', 'www.bing.com'), 'bing');
});

test('crawlers: known bots, user-triggered fetchers, ordinary browsers and look-alikes', () => {
  const ua = [
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'GPTBot', 'training'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', 'ChatGPT-User', 'live'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)', 'Claude-User', 'live'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot', 'training'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'PerplexityBot', 'search'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)', 'Perplexity-User', 'live'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)', 'OAI-SearchBot', 'search'],
    ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'meta-externalagent', 'training'],
    ['Claude-Code/1.0.0', 'Claude-Code', 'agent'],
    ['Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)', 'MistralAI-User', 'live'],
  ];
  for (const [s, name, purpose] of ua) {
    const c = crawlerOf(s);
    assert.equal(c?.name, name, s);
    assert.equal(c.purpose, purpose, s);
    assert.equal(c.live, purpose === 'live');
  }
  for (const s of [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', // a search crawler, not on the AI list
    'Sogou web spider/4.0', // "Spider" is on the list, spelled with a capital S
    'NotGPTBot/1.0', 'GPTBotX/1.0', 'xClaudeBot', 'code-server/4.0', 'Mozilla/5.0 GPTBot-like', '', null, 'G'.repeat(2000),
    // Local overrides: ordinary software and robots.txt-only tokens.
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.95.0 Chrome/128.0 Electron/32.2.1 Safari/537.36',
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/0.42.3 Chrome/124.0 Electron/30.1.2 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) Operator Chrome/140.0', 'Google-Extended', 'Applebot-Extended/1.0',
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Trae/1.104.3 Chrome/138.0 Electron/37.2.3 Safari/537.36',
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) SomeApp/2.0 GPTBot Chrome/138.0 Electron/37.2.3 Safari/537.36',
  ]) assert.equal(crawlerOf(s), null, String(s).slice(0, 60));
  assert.deepEqual([200, 301, 404, 503, 99, undefined, '204'].map(statusClass), ['2xx', '3xx', '4xx', '5xx', 'unknown', 'unknown', '2xx']);
});

test('countCrawler: counters by status and capped paths on the day\'s totals; never an IP, a user agent or a query', async () => {
  const store = memoryStore();
  const GPT = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)';
  const at = new Date('2026-10-09T10:00:00Z');
  const headers = { 'user-agent': GPT, 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.4' };
  const r1 = await countCrawler(new Request('https://example.com/pricing?email=probe.person%40example.com', { headers }), store, { status: 200, now: at, timeZone: 'Europe/Berlin' });
  assert.deepEqual(r1, { day: '2026-10-09', bot: 'GPTBot', purpose: 'training' });
  await countCrawler(new Request('https://example.com/docs/v1.2', { headers }), store, { status: 404, now: at });
  await countCrawler(new Request('https://example.com/invite/Pq7xK2mZ9_wR4tY-8sLnB', { headers }), store, { status: 200, now: at });
  await countCrawler(new Request('https://example.com/account/settings', { headers }), store, { status: 302, now: at, skip: '/^\\/account(\\/|$)/i' });
  // An Express-style request: url and a plain headers object; no status known.
  await countCrawler({ url: '/', headers: { 'user-agent': 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)' } }, store, { now: at });
  for (let i = 0; i < 40; i++) await countCrawler(new Request(`https://example.com/p${i}`, { headers }), store, { status: 200, now: at });
  // An ordinary visitor: the store is not touched.
  const before = JSON.stringify([...store.daily.values()]);
  assert.equal(await countCrawler(new Request('https://example.com/', { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36' } }), store, { status: 200 }), null);
  assert.equal(JSON.stringify([...store.daily.values()]), before);
  const doc = store.daily.get('2026-10-09 *');
  assert.deepEqual(doc.crawl.gptbot, { '2xx': 42, '4xx': 1, '3xx': 1 });
  assert.deepEqual(doc.crawl['chatgpt-user'], { unknown: 1 });
  assert.equal(doc.crawlp.gptbot['/pricing'], 1);
  assert.equal(doc.crawlp.gptbot['/docs/v1%2E2'], 1, 'a dot is written %2E, as in 404 keys');
  assert.equal(Object.keys(doc.crawlp.gptbot).length, 31, '30 paths, then (other)');
  assert.equal(doc.crawlp.gptbot['(other)'], 2 + 12, 'the token path, the private path and the paths past the cap');
  const all = JSON.stringify([...store.daily.values()]);
  for (const bad of ['203.0.113', '198.51.100', 'Mozilla', 'openai.com', 'probe', 'Pq7xK2', 'account', 'email']) assert.ok(!all.includes(bad), bad);
  const totals = crawlerTotals(doc);
  assert.equal(totals[0].name, 'GPTBot');
  assert.equal(totals[0].total, 44);
  assert.equal(totals[1].purpose, 'live');
  // A failing store: the promise still resolves, onError hears about it.
  let heard = null;
  const failing = { write: async () => { throw new Error('down'); } };
  assert.equal(await countCrawler(new Request('https://example.com/', { headers }), failing, { onError: (e) => (heard = e.message) }), null);
  assert.equal(heard, 'down');
});

test('the vendored crawler list: dated, sourced, deduplicated, and the update script\'s rules', () => {
  assert.match(CRAWLERS_SNAPSHOT.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(CRAWLERS_SNAPSHOT.source, /ai-robots-txt\/ai\.robots\.txt\/9ad8a47e23f7689ec3ea2423a47569d0bb91bdaf\/robots\.json$/);
  assert.equal(CRAWLERS_SNAPSHOT.commit, '9ad8a47e23f7689ec3ea2423a47569d0bb91bdaf');
  for (const n of Object.keys(NOT_IN_USER_AGENTS)) assert.equal(crawlerOf(`Mozilla/5.0 (compatible; ${n}/1.0)`), null, n);
  const names = CRAWLERS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'CCBot']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('MistralAI-User/1.0') && !names.includes('Brightbot 1.0'), 'versioned duplicates dropped');
  assert.ok(CRAWLERS.every((c) => ['live', 'agent', 'search', 'training', 'other'].includes(c.purpose) && c.operator.length <= 40));
  assert.equal(purposeOf('ChatGPT-User', 'AI Assistants'), 'live');
  assert.equal(purposeOf('Foo-User', 'Unclear at this time.'), 'live');
  assert.equal(purposeOf('X', 'Retrieves data to provide responses to user-initiated prompts.'), 'live');
  assert.equal(purposeOf('X', 'AI Coding Agents'), 'agent');
  assert.equal(purposeOf('X', 'Search result generation.'), 'search');
  assert.equal(purposeOf('X', 'AI research crawler'), 'other', '"research" is not search');
  assert.equal(purposeOf('X', 'Scrapes data to train OpenAI\'s products.'), 'training');
  assert.equal(operatorOf('[OpenAI](https://openai.com)'), 'OpenAI');
  assert.equal(operatorOf('Unclear at this time.'), '');
  assert.deepEqual(compact({ 'A-User': { function: 'AI Assistants', operator: '[A](https://a)' }, 'A-User/1.0': { function: 'x' }, 'b-bot': {}, 'B-Bot': {} }).map((c) => c.name), ['A-User', 'b-bot', 'B-Bot']);
});

// A key pair made for the test; the "service account" holds its private half.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SA = { type: 'service_account', client_email: 'digest@project.iam.gserviceaccount.com', private_key: privateKey };
const b64json = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('gsc: the JWT is RS256, signed by the service account\'s key, for the read-only scope, one hour', () => {
  const now = Date.parse('2026-10-09T06:00:00Z');
  const jwt = signJwt(JSON.stringify(SA), { now });
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(b64json(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(b64json(c), { iss: SA.client_email, scope: GSC_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now / 1000, exp: now / 1000 + 3600 });
  assert.equal(GSC_SCOPE, 'https://www.googleapis.com/auth/webmasters.readonly');
  assert.ok(!/[+/=]/.test(jwt), 'base64url');
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), 'the signature verifies with the public key');
  assert.throws(() => signJwt('{not json'), /not valid JSON/);
  assert.throws(() => signJwt({ client_email: 'x' }), /private_key/);
  assert.deepEqual(gscQuery('2026-10-06', 'query'), { startDate: '2026-10-06', endDate: '2026-10-06', type: 'web', rowLimit: 50, dimensions: ['query'] });
  assert.deepEqual(gscQuery('2026-10-06', null), { startDate: '2026-10-06', endDate: '2026-10-06', type: 'web', rowLimit: 1 });
  assert.equal(queryUrl('sc-domain:example.com'), 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
});

function gscFetch({ tokenStatus = 200 } = {}) {
  return fakeFetch((call) => {
    if (call.url === 'https://oauth2.googleapis.com/token') return tokenStatus === 200 ? { json: { access_token: 'ya29.ab', expires_in: 3599 } } : { status: tokenStatus, json: { error: 'invalid_grant', error_description: 'bad' } };
    const body = JSON.parse(call.body);
    if (!body.dimensions) return { json: { rows: [{ clicks: 120, impressions: 4000, ctr: 0.03, position: 8.2 }] } };
    if (body.dimensions[0] === 'query') {
      return { json: { rows: [
        { keys: ['privacy analytics'], clicks: 40, impressions: 900, position: 4.13 },
        { keys: ['jane.doe@example.com'], clicks: 2, impressions: 3, position: 1 },
        { keys: ['cookieless\ntracking'], clicks: 10, impressions: 300, position: 9 },
      ] } };
    }
    return { json: { rows: [
      { keys: ['https://www.example.com/pricing?ref=x'], clicks: 30, impressions: 500, position: 3 },
      { keys: ['https://www.example.com/account/42'], clicks: 1, impressions: 2, position: 1 },
      { keys: ['https://www.example.com/invite/Pq7xK2mZ9_wR4tY-8sLnB'], clicks: 1, impressions: 1, position: 1 },
    ] } };
  });
}

test('gsc: the daily job asks for the day 3 days ago, stores the top queries and pages, hides what looks personal or private', async () => {
  const sqlite = await sqliteQuery();
  const stores = [['memory', memoryStore()], ['mongo', mongoStore(fakeMongo().db)]];
  if (sqlite) {
    const s = sqlStore({ dialect: 'sqlite', query: sqlite.query });
    await s.init();
    stores.push(['sqlite', s]);
  }
  for (const [name, store] of stores) {
    const fetch = gscFetch();
    const logged = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a) => logged.push(a.join(' '));
    let r;
    try {
      r = await gscDaily({ serviceAccount: SA, siteUrl: 'https://www.example.com/', store, skip: '/^\\/account(\\/|$)/i', fetch, now: new Date('2026-10-09T05:00:00Z') });
    } finally {
      [console.log, console.error, console.warn] = orig;
    }
    // 05:00 UTC on 9 Oct is still 8 Oct in Pacific Time: 3 days back is 5 Oct. The 3 days
    // before it were never stored, so they are fetched too.
    assert.deepEqual(r, { day: '2026-10-05', queries: 2, pages: 1, hidden: { queries: 1, pages: 2 }, refetched: ['2026-10-04', '2026-10-03', '2026-10-02'] }, name);
    assert.equal(fetch.calls[0].url, 'https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(fetch.calls[0].body);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(form.get('assertion').split('.').length, 3);
    for (const c of fetch.calls.slice(1)) {
      assert.equal(c.url, 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query');
      assert.equal(c.headers.authorization, 'Bearer ya29.ab');
    }
    assert.deepEqual([...new Set(fetch.calls.slice(1).map((c) => JSON.parse(c.body).startDate))], ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
    const doc = await store.gsc('2026-10-05');
    assert.deepEqual(doc.totals, { clicks: 120, impressions: 4000 }, name);
    assert.deepEqual(doc.queries.map((q) => q.q), ['privacy analytics', 'cookieless tracking'], name);
    assert.deepEqual(doc.queries[0], { q: 'privacy analytics', clicks: 40, impressions: 900, position: 4.1 });
    assert.deepEqual(doc.pages, [{ p: '/pricing', clicks: 30, impressions: 500, position: 3 }], name);
    assert.ok(!JSON.stringify(doc).includes('novak') && !JSON.stringify(doc).includes('PRIVATE KEY'));
    assert.equal(logged.length, 0, 'nothing logged');
  }
  // A failed token request names the status and Google's code, never the key or the assertion.
  const err = await gscDaily({ serviceAccount: SA, siteUrl: 'sc-domain:example.com', store: memoryStore(), fetch: gscFetch({ tokenStatus: 400 }) }).catch((e) => e);
  assert.match(err.message, /token request failed \(400 invalid_grant\)/);
  assert.ok(!err.message.includes('PRIVATE') && !err.message.includes('eyJ'), err.message);
  await assert.rejects(gscDaily({ serviceAccount: SA, siteUrl: 'example.com', store: memoryStore(), fetch: gscFetch() }), /siteUrl/);
  // The next day: only a stored day with no clicks and no impressions is fetched again.
  const store = memoryStore();
  await store.saveGsc('2026-10-04', gscDoc('2026-10-04', { totals: [{ clicks: 3, impressions: 9 }] }));
  await store.saveGsc('2026-10-03', gscDoc('2026-10-03', { totals: [] }));
  await store.saveGsc('2026-10-02', gscDoc('2026-10-02', { totals: [{ clicks: 0, impressions: 4 }] }));
  const again = await gscDaily({ serviceAccount: SA, siteUrl: 'sc-domain:example.com', store, fetch: gscFetch(), now: new Date('2026-10-08T20:00:00Z') });
  assert.equal(again.day, '2026-10-05');
  assert.deepEqual(again.refetched, ['2026-10-03']);
  assert.equal((await store.gsc('2026-10-03')).totals.clicks, 120);
  assert.equal((await store.gsc('2026-10-03')).fetches, 2);
  // A day that stays empty is asked for at most 3 times in all.
  const empty = memoryStore();
  await empty.saveGsc('2026-10-04', { ...gscDoc('2026-10-04', {}), fetches: 3 });
  await empty.saveGsc('2026-10-03', { ...gscDoc('2026-10-03', {}), fetches: 2 });
  await empty.saveGsc('2026-10-02', { ...gscDoc('2026-10-02', { totals: [{ clicks: 1 }] }) });
  const third = await gscDaily({ serviceAccount: SA, siteUrl: 'sc-domain:example.com', store: empty, fetch: gscFetch(), now: new Date('2026-10-08T20:00:00Z') });
  assert.deepEqual(third.refetched, ['2026-10-03']);
  assert.equal((await empty.gsc('2026-10-03')).fetches, 3);
  await assert.rejects(gscDaily({ serviceAccount: SA, siteUrl: 'sc-domain:example.com', store: { write() {} }, fetch: gscFetch() }), /saveGsc/);
});

test('gsc documents follow their own retention (16 months by default)', async () => {
  const store = memoryStore();
  await store.saveGsc('2025-05-01', gscDoc('2025-05-01', {}));
  await store.saveGsc('2026-10-01', gscDoc('2026-10-01', {}));
  await enforceRetention({ store, now: new Date('2026-10-09T12:00:00Z') });
  assert.equal(await store.gsc('2025-05-01'), null);
  assert.ok(await store.gsc('2026-10-01'));
});

test('weekly digest: AI assistants, AI crawlers and Search Console movers, escaped', async () => {
  const store = memoryStore();
  const W = '2026-09-28';
  for (let w = 0; w < 2; w++) {
    for (let i = 0; i < 7; i++) {
      const day = addDays(W, -7 * w + i);
      store.daily.set(`${day} *`, { _id: `${day} *`, day, path: '*', visits: 50, src: { google: 40, chatgpt: w ? 2 : 6, claude: w ? 0 : 3 } });
      await store.saveGsc(day, {
        totals: { clicks: w ? 30 : 50, impressions: 1000 },
        queries: [{ q: 'privacy analytics', clicks: w ? 2 : 6 }, { q: '<!here> skill', clicks: w ? 0 : 3 }, { q: 'old query', clicks: w ? 3 : 0 }],
        pages: [],
      });
    }
  }
  await countCrawler(new Request('https://example.com/', { headers: { 'user-agent': 'Perplexity-User/1.0' } }), store, { status: 200, now: new Date('2026-09-30T10:00:00Z') });
  const { text, data } = await weeklyDigest({ store, week: W });
  assert.match(text, /AI assistants 60 \(chatgpt 40, claude 20\)/, 'no percentage on a base under minSample: ' + text);
  assert.match(text, /Visits 350 · last week 350 \(0%\) · 1-week average 350 \(0%\)/, 'the average covers the weeks with data');
  assert.deepEqual(data.aiVisits, { cur: 63, prev: 14 });
  assert.match(text, /\*Google Search \(data for 7 of 7 days so far; Search Console lags 2–3 days\)\*\nClicks 350 · last week 210 \(\+67%\)/);
  assert.match(text, /Top movers: "privacy analytics" 40 \(was 10\) · "&lt;!here&gt; skill" 20 \(was 0\) · "old query" 0 \(was 20\)/);
  assert.match(text, /Perplexity-User <10 \(fetched live for an answer\), most on \//);
});
