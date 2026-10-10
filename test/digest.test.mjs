/**
 * Module 7: the weekly digest (digest.mjs), goals by source, consent counts,
 * the campaign allowlist and deploy markers (collector.mjs), "after deploy"
 * in health alerts. Unit tests; the browser parts are in browser.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createCollector, memoryStore, fileStore, mongoStore, sqlStore, analyticsEngineStore, markDeploy, DEPLOY_CAP, SOURCE_CLASSES, sourceClass,
} from '../skills/sectionsight/assets/collector.mjs';
import { weeklyDigest, roundCount, mondayOf } from '../skills/sectionsight/assets/digest.mjs';
import { checkHealth, addDays } from '../skills/sectionsight/assets/health.mjs';
import { fakeMongo, sqliteQuery } from './fakes.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
function req(body, headers = {}) {
  return new Request('https://example.com/api/k', {
    method: 'POST',
    headers: { origin: 'https://example.com', referer: 'https://example.com/', 'user-agent': UA, 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: JSON.stringify(body),
  });
}
const visitsDoc = (store) => [...store.daily.values()].find((d) => d.path === '*') ?? {};
const HEX16 = /\b[0-9a-f]{16}\b/;

test('roundCount: 0 stays, under 10 is hidden, then tens; "none" is exact', () => {
  assert.deepEqual([0, 1, 9, 10, 14, 15, 94, 1234].map((n) => roundCount(n)), [0, null, null, 10, 10, 20, 90, 1230]);
  assert.deepEqual([0, 3, 14].map((n) => roundCount(n, 'none')), [0, 3, 14]);
  assert.equal(mondayOf('2026-10-04'), '2026-09-28', 'a Sunday belongs to the week before');
  assert.equal(mondayOf('2026-09-28'), '2026-09-28');
});

// Five weeks: the reported week starts Monday 28 Sep 2026; the four before are
// the baseline. The week has twice the visits, a new source, a new outbound
// host and 404 path, a new error, a read-rate jump, slow LCP, consent counts,
// goals by source, crawlers and a deploy. Browser-made keys try to ping Slack.
const W = '2026-09-28';
function fiveWeeks() {
  const store = memoryStore();
  for (let w = 0; w < 5; w++) {
    for (let i = 0; i < 7; i++) {
      const day = addDays(W, -7 * w + i);
      const now = w === 0;
      const k = now ? 2 : 1;
      store.daily.set(`${day} *`, {
        _id: `${day} *`, day, path: '*', visits: 10 * k,
        src: { google: 10 * k, direct: 6, chatgpt: now ? 3 : 1, perplexity: now ? 1 : 0, ...(now ? { '<!channel>': 2 } : {}) },
        goal: { signup: 2 * k }, goalsrc: { signup: { google: k, ai: now ? 1 : 0 } },
        ...(now ? { consent: { shown: 30, accept: 8, decline: 12, withdraw: 1 } } : {}),
        nf: now ? { '/old%2Epage': 3 } : { '/wp-login%2Ephp': 1 },
        crawl: { gptbot: { '2xx': 5 }, 'chatgpt-user': { '2xx': 2, '4xx': 1 } }, crawlp: { gptbot: { '/': 5 } },
      });
      store.daily.set(`${day} /pricing`, {
        _id: `${day} /pricing`, day, path: '/pricing', views: 20 * k,
        // plans moves; faq stays under 10 a week; compare goes from 40 a week to none ("<10" is not 0).
        sec: { plans: { r: now ? 18 : 5, s: 40 }, faq: { r: 1 }, compare: { r: now ? 0 : 5 } },
        out: now ? { 'github.com': 1, 'evil<b>.com': 2 } : { 'github.com': 1 },
        err: now ? { abcd1234: 4 } : {},
        cwv: { mobile: { lcp: { 5: 6, 6: 10 }, inp: { 0: 16 } } }, cwvs: { lcp: { hero: 8 } },
      });
    }
  }
  return store;
}

test('weekly digest: this week vs last week and the 4-week average, counts beside every percentage, rounded', async () => {
  const store = fiveWeeks();
  await markDeploy({ store, sha: 'ABCDEF1234567890', at: '2026-09-30T10:00:00Z', note: 'v1.4' });
  store.errs.set('2026-09-29', { abcd1234: { m: 'TypeError: <script>x</script> is not a function', f: 'app.js', l: 3, c: 1, path: '/pricing' } });
  const { text, from, to, data } = await weeklyDigest({ store, week: '2026-10-01', site: 'example.com', timeZone: 'Europe/Berlin' });
  assert.deepEqual([from, to], ['2026-09-28', '2026-10-04']);
  assert.match(text, /^\*Weekly · example\.com · 28 Sept – 4 Oct 2026\*/);
  assert.match(text, /Visits 140 · last week 70 \(\+100%\) · 4-week average 70 \(\+100%\)/);
  assert.match(text, /Page views 280 · last week 140 \(\+100%\)/);
  // Rounding: 21 chatgpt visits → 20; 7 perplexity → <10; 14 "<!channel>" → 10, no percentage under minSample.
  assert.match(text, /AI assistants 30 \(chatgpt 20, perplexity <10\)/);
  assert.match(text, /direct 40 \(0%\)/);
  // The read-rate mover, from rounded counts: 126 → 130 of 280, 35 → 40 of 140.
  assert.match(text, /\/pricing · plans: 46% read \(130 of 280\), last week 29% \(40 of 140\), \+17 pts/);
  assert.ok(!/faq|compare/.test(text), 'a read count under minSample (or "<10") is never a mover');
  assert.match(text, /signup 30 · last week 10 · google 10, ai <10, entry unknown <10/);
  assert.match(text, /accepted 60 · declined 80 · withdrawn <10 · accept rate 43% of answers/);
  assert.match(text, /cover only the people who accepted \(about 43%/);
  assert.match(text, /New 404 paths: \/old\.page 20/);
  assert.match(text, /\/pricing · mobile LCP over 6 s \(poor, 110 views\) · poor mostly in hero \(60\)/);
  assert.ok(!/INP/.test(text), 'a good INP is not listed');
  assert.match(text, /GPTBot 40 \(collecting training data\), most on \/ · ChatGPT-User 20 \(fetched live for an answer\)/);
  assert.match(text, /abcdef1 Wed 30 Sept, 12:00 \(v1\.4\)/, 'the deploy, in the owner\'s time zone');
  assert.deepEqual(data.fresh.sources, ['<!channel>']);
  assert.deepEqual(data.fresh.outbound, ['evil<b>.com']);
  assert.deepEqual(data.fresh.errors, ['abcd1234']);
  // Escaped for Slack: nothing a browser sent can ping or format.
  assert.ok(!text.includes('<!channel>') && text.includes('&lt;!channel&gt;'));
  assert.ok(text.includes('evil&lt;b&gt;.com'));
  // An error by fingerprint, file and line; its message only when the owner asks.
  assert.match(text, /New JavaScript errors: error abcd1234 · app\.js:3 \(30\)/);
  assert.ok(!text.includes('script&gt;x'), 'no message by default');
  const shown = await weeklyDigest({ store, week: W, showErrorText: true });
  assert.match(shown.text, /New JavaScript errors: TypeError: &lt;script&gt;x&lt;\/script&gt; is not a function · app\.js:3 \(30\)/);
  assert.ok(!/<(?!10)/.test(text), 'the only "<" is "<10": ' + text);
  assert.ok(!HEX16.test(text), 'no id');
  assert.match(text, /_Counts under 10 show as <10/);
});

test('weekly digest: exact counts on request; the guards keep small changes and empty sections out', async () => {
  const exact = await weeklyDigest({ store: fiveWeeks(), week: W, rounding: 'none', format: 'text' });
  assert.match(exact.text, /AI assistants 28 \(chatgpt 21, perplexity 7\)/);
  assert.ok(!exact.text.includes('&lt;'), 'plain text is not Slack-escaped');
  assert.ok(!/Counts under 10/.test(exact.text));
  // A quiet site: under minSample, no percentages and no movers; no sections for what is not there.
  const store = memoryStore();
  for (let w = 0; w < 5; w++) {
    const day = addDays(W, -7 * w);
    store.daily.set(`${day} *`, { _id: `${day} *`, day, path: '*', visits: 4, src: { google: 4 } });
    store.daily.set(`${day} /`, { _id: `${day} /`, day, path: '/', views: 5, sec: { intro: { r: w ? 1 : 4 } } });
  }
  const { text } = await weeklyDigest({ store, week: W });
  assert.match(text, /Visits <10 · last week <10 · 4-week average <10$/m);
  assert.ok(!/%/.test(text.split('\n').slice(1, 3).join('\n')), text);
  for (const s of ['Read-rate changes', 'Goals', 'Consent', 'New this week', 'Slow pages', 'AI crawlers', 'Deploys', 'Google Search']) assert.ok(!text.includes(s), `${s} left out`);
  await assert.rejects(weeklyDigest({ store: analyticsEngineStore({ writeDataPoint() {} }) }), /totals/);
});

test('weekly digest: no accept rate while a count shows as "<10"; Search Console queries can be left out', async () => {
  const store = fiveWeeks();
  for (const doc of store.daily.values()) if (doc.consent) doc.consent = { shown: 30, accept: 1, decline: 12 };
  const { text, data } = await weeklyDigest({ store, week: W });
  assert.match(text, /accepted <10 · declined 80/);
  assert.equal(data.consent.rate, null);
  assert.ok(!/accept rate/.test(text) && /too few answers/.test(text), text);
  for (let i = 0; i < 7; i++) await store.saveGsc(addDays(W, i), { totals: { clicks: 10, impressions: 100 }, queries: [{ q: 'jane doe', clicks: 5 }], pages: [] });
  const hidden = await weeklyDigest({ store, week: W, gscQueries: false });
  assert.match(hidden.text, /Clicks 70/);
  assert.ok(!hidden.text.includes('novak') && !/Top movers/.test(hidden.text));
  assert.match((await weeklyDigest({ store, week: W })).text, /"jane doe"/);
});

test('goals by source: the entry\'s class only (SOURCE_CLASSES), never a referrer; the row stays { k }', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store });
  const goal = (extra) => collect(req({ p: '/', e: 'goal', d: { k: 'signup' }, ...extra }));
  await goal({ gr: 'chatgpt.com' });
  await goal({ gr: '', gu: 'chatgpt.com' });
  await goal({ gr: 'jane-doe.github.io' });
  await goal({ gr: 'www.google.com', gu: 'newsletter' });
  await goal({ gr: '' });
  await goal({ gr: 'example.com' }); // a page load that continued the visit: no class
  await goal({}); // no entry at all
  await goal({ gr: '<script>', gu: 'jane.doe@example.com' });
  const v = visitsDoc(store);
  assert.equal(v.goal.signup, 8);
  assert.deepEqual(v.goalsrc.signup, { ai: 2, other: 1, newsletter: 1, direct: 2 });
  assert.ok(Object.keys(v.goalsrc.signup).every((k) => SOURCE_CLASSES.includes(k)));
  assert.ok(!JSON.stringify(v).includes('github') && !JSON.stringify(v).includes('novak'));
  // campaignTotals false: the utm_source is ignored for the class too.
  const s2 = memoryStore();
  await createCollector({ hosts: ['example.com'], store: s2, campaignTotals: false })(req({ p: '/', e: 'goal', d: { k: 'signup' }, gr: '', gu: 'newsletter' }));
  assert.deepEqual(visitsDoc(s2).goalsrc.signup, { direct: 1 });
  // With consent: the row of the goal keeps only its name.
  const s3 = memoryStore();
  await createCollector({ hosts: ['example.com'], store: s3 })(req({ p: '/', e: 'goal', d: { k: 'signup' }, gr: 'chatgpt.com', vi: '0123456789abcdef', v: 'fedcba9876543210' }));
  assert.deepEqual(s3.rows[0].d, { k: 'signup' });
  assert.equal(sourceClass('perplexity'), 'ai');
  assert.equal(sourceClass('seznam'), 'search');
  assert.equal(sourceClass('acme.example'), 'other');
});

test('consent counts: counted only when the collector is told to, never a row, never with GPC', async () => {
  const ids = { vi: '0123456789abcdef', v: 'fedcba9876543210' };
  const off = memoryStore();
  await createCollector({ hosts: ['example.com'], store: off })(req({ p: '/', e: 'consent', d: { k: 'accept' } }));
  assert.equal(off.daily.size, 0, 'consentCounts is off by default');
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, consentCounts: true });
  for (const k of ['shown', 'shown', 'accept', 'decline', 'withdraw', 'maybe']) await collect(req({ p: '/', e: 'consent', d: { k }, ...ids }));
  await collect(req({ p: '/', e: 'consent', d: { k: 'accept' } }, { 'sec-gpc': '1' }));
  assert.deepEqual(visitsDoc(store).consent, { shown: 2, accept: 1, decline: 1, withdraw: 1 });
  assert.equal(store.rows.length, 0, 'never a row, even with ids on the report');
  assert.ok(![...store.daily.values()].some((d) => d.path === '/'), 'no page counters either');
});

test('campaign allowlist: only listed utm_campaign values reach the totals, the rest is (other)', async () => {
  const entry = (campaign) => ({ p: '/', en: 1, r: '', u: { source: 'newsletter', campaign }, l: 'en', d: { of: 1 } });
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, campaigns: ['Spring-Sale', 'launch.2026'] });
  for (const c of ['spring-sale', 'SPRING-SALE', 'launch.2026', 'for-jane-doe', 'jane.doe@example.com']) await collect(req(entry(c)));
  await collect(req({ ...entry('spring-sale'), en: 2 })); // a repeated entry is not a new visit
  assert.deepEqual(visitsDoc(store).campaign, { 'spring-sale': 2, launch_2026: 1, '(other)': 1 }, 'a personal-looking tag is dropped before the allowlist');
  for (const opts of [{}, { campaigns: ['spring-sale'], campaignTotals: false }]) {
    const s = memoryStore();
    await createCollector({ hosts: ['example.com'], store: s, ...opts })(req(entry('spring-sale')));
    assert.equal(visitsDoc(s).campaign, undefined, JSON.stringify(opts));
  }
});

test('markDeploy: 7 hex characters and the minute in the day\'s totals, capped, once per sha, in every store', async () => {
  const sqlite = await sqliteQuery();
  const dir = await mkdtemp(path.join(tmpdir(), 'sectionsight-deploy-'));
  const stores = [['memory', memoryStore()], ['files', fileStore(dir)], ['mongo', mongoStore(fakeMongo().db)]];
  if (sqlite) {
    const s = sqlStore({ dialect: 'sqlite', query: sqlite.query });
    await s.init();
    stores.push(['sqlite', s]);
  }
  for (const [name, store] of stores) {
    const at = (i) => new Date(Date.parse('2026-10-09T08:00:00Z') + i * 60_000);
    // Written newest first: every store keeps the 20 newest by time, not the last written.
    for (let i = DEPLOY_CAP + 4; i >= 0; i--) await markDeploy({ store, sha: (0xabc0000 + i).toString(16) + '99999', at: at(i) });
    const again = await markDeploy({ store, sha: (0xabc0000 + DEPLOY_CAP + 4).toString(16), at: at(40) });
    assert.equal(again.skipped, 'already marked', name);
    const r = await markDeploy({ store, sha: 'F00DBABE', at: at(50), note: 'call jane.doe@example.com' });
    assert.deepEqual(Object.keys(r).sort(), ['at', 'day', 'sha'], `${name}: a note that looks personal is dropped`);
    await markDeploy({ store, sha: '1234567', at: at(51), note: 'v2.0 hotfix' });
    const list = (await store.totals('2026-10-09'))['2026-10-09 *'].deploys;
    assert.equal(list.length, DEPLOY_CAP, name);
    assert.ok(list.every((d) => /^[0-9a-f]{7}$/.test(d.sha) && /:00\.000Z$/.test(d.at)), `${name}: ${JSON.stringify(list)}`);
    assert.deepEqual(list.at(-1), { sha: '1234567', at: '2026-10-09T08:51:00.000Z', note: 'v2.0 hotfix' }, name);
    assert.ok(!list.some((d) => d.sha === 'abc0000'), `${name}: the oldest went`);
  }
  await assert.rejects(markDeploy({ store: memoryStore(), sha: 'main' }), /sha/);
  assert.ok((await markDeploy({ store: analyticsEngineStore({ writeDataPoint() {} }), sha: 'abcdef1' })).unsupported);
});

test('health alerts say "after deploy <sha>" when a deploy came within the last 24 hours', async () => {
  const NOW = new Date('2026-10-09T14:30:00Z');
  const store = memoryStore();
  for (let k = 1; k <= 4; k++) {
    const d = addDays('2026-10-09', -7 * k);
    store.daily.set(`${d} *`, { _id: `${d} *`, day: d, path: '*', nf: { '/x': 1 } });
  }
  store.daily.set('2026-10-09 *', { _id: '2026-10-09 *', day: '2026-10-09', path: '*', nf: { '/x': 40 } });
  const only = { silence: false, low: false, goal: false, writes: false, errors: false };
  const before = await checkHealth({ store, now: NOW, rules: only });
  assert.ok(!/after deploy/.test(before.alerts[0].text));
  await markDeploy({ store, sha: '9f8e7d6c5b', at: '2026-10-08T22:10:00Z' });
  const after = await checkHealth({ store, now: NOW, rules: only });
  assert.match(after.alerts[0].text, /404s today: 40.*\(after deploy 9f8e7d6 at 2026-10-08 22:10 UTC\)$/);
  const berlin = await checkHealth({ store, now: NOW, rules: only, timeZone: 'Europe/Berlin' });
  assert.match(berlin.alerts[0].text, /\(after deploy 9f8e7d6 at 2026-10-09 00:10 Europe\/Berlin\)$/, 'in the owner\'s time zone');
  const later = await checkHealth({ store, now: new Date('2026-10-09T23:00:00Z'), rules: only });
  assert.ok(!/after deploy/.test(later.alerts[0].text), 'not after 24 hours');
});
