/**
 * Health and anomaly alerts (health.mjs) on synthetic totals, and the
 * collector's health record (collector.mjs) on a working and a failing store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, memoryStore, fileStore, mongoStore, readHealth, errorClass } from '../skills/sectionsight/assets/collector.mjs';
import { checkHealth, alertText, postAlerts, analyticsEngineReader, addDays, median } from '../skills/sectionsight/assets/health.mjs';
import { fakeMongo, fakeFetch } from './fakes.mjs';

// Friday 9 October 2026, 14:30 UTC. The baseline Fridays: 2 Oct, 25 Sep, 18 Sep, 11 Sep.
const NOW = new Date('2026-10-09T14:30:00Z');
const TODAY = '2026-10-09';
const FRIDAYS = [1, 2, 3, 4].map((k) => addDays(TODAY, -7 * k));

/** A store with "<day> *" documents; `perHour(h)` gives each hour's visits. */
function storeWith(days) {
  const store = memoryStore();
  for (const [day, doc] of Object.entries(days)) store.daily.set(`${day} *`, { _id: `${day} *`, day, path: '*', ...doc });
  return store;
}
const hours = (perHour, upTo = 24) => Object.fromEntries(Array.from({ length: upTo }, (_, h) => [String(h).padStart(2, '0'), perHour(h)]).filter(([, n]) => n));
const busy = (n) => ({ hour: hours(() => n), visits: n * 24 });
const rulesOnly = (name) => Object.fromEntries(['silence', 'low', 'goal', 'writes', 'notFound'].map((r) => [r, r === name ? {} : false]));
const keys = (r) => r.alerts.map((a) => a.rule);

test('helpers: median, days', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('(a) silence: no visit for 3 hours while those hours are usually busy', async () => {
  const days = Object.fromEntries(FRIDAYS.map((d) => [d, busy(4)]));
  days[TODAY] = { hour: hours((h) => (h < 11 ? 4 : 0)) };
  const r = await checkHealth({ store: storeWith(days), now: NOW, rules: rulesOnly('silence') });
  assert.deepEqual(keys(r), ['silence']);
  assert.equal(r.alerts[0].severity, 'critical');
  assert.match(r.alerts[0].text, /No visit stored for 3 hours.*12 \(median\)/);
  // One visit in the current hour: not silent.
  days[TODAY].hour['14'] = 1;
  assert.deepEqual(keys(await checkHealth({ store: storeWith(days), now: NOW, rules: rulesOnly('silence') })), []);
});

test('(a) silence: a tiny site does not flap (the baseline is under the minimum)', async () => {
  const days = Object.fromEntries(FRIDAYS.map((d) => [d, busy(1)]));
  days[TODAY] = { hour: {} };
  const r = await checkHealth({ store: storeWith(days), now: NOW });
  assert.deepEqual(keys(r), [], 'three usual visits in those hours are not enough to call silence');
});

test('(a, b) without hourly counts in the baseline the rules say so instead of guessing', async () => {
  const days = Object.fromEntries(FRIDAYS.map((d) => [d, { visits: 500 }]));
  const r = await checkHealth({ store: storeWith(days), now: NOW });
  assert.deepEqual(keys(r), []);
  assert.ok(r.notes.some((n) => n.startsWith('silence: no hourly counts')), r.notes.join(' | '));
});

test('(b) low: visits so far today under 40% of the same hours of earlier Fridays', async () => {
  const days = Object.fromEntries(FRIDAYS.map((d) => [d, busy(5)]));
  days[TODAY] = { hour: hours((h) => (h < 10 ? 1 : 0), 14) }; // 10 by 14:00, usually 70
  days[TODAY].hour['13'] = 1; // not silent
  const r = await checkHealth({ store: storeWith(days), now: NOW, rules: rulesOnly('low') });
  assert.deepEqual(keys(r), ['low']);
  assert.match(r.alerts[0].text, /by 14:00: 11, usually 70/);
  // Small baseline (14 by 14:00, under minBaseline 20): no alert, even at zero.
  const tiny = Object.fromEntries(FRIDAYS.map((d) => [d, busy(1)]));
  tiny[TODAY] = { hour: {} };
  assert.deepEqual(keys(await checkHealth({ store: storeWith(tiny), now: NOW, rules: rulesOnly('low') })), []);
});

test('(c) a goal at 0 for 3 days while it usually happens daily; a rare goal does not alert', async () => {
  const days = {};
  for (let i = 4; i <= 31; i++) days[addDays(TODAY, -i)] = { goal: { signup: 2, demo: i % 3 === 0 ? 1 : 0 } };
  for (let i = 1; i <= 3; i++) days[addDays(TODAY, -i)] = { goal: {} };
  const r = await checkHealth({ store: storeWith(days), now: NOW, rules: rulesOnly('goal') });
  assert.deepEqual(keys(r), ['goal:signup'], 'demo: median 0 a day, so silence is normal');
  assert.match(r.alerts[0].text, /Goal "signup": 0 in the last 3 days, usually 2 a day/);
});

test('(d) writes: failures in the health record, and reports with no write', async () => {
  const store = memoryStore();
  await store.saveHealth({ lastWrite: '2026-10-09T14:00:00.000Z', writeErrors: 3, lastError: 'MongoNetworkError ECONNREFUSED', lastReport: '2026-10-09T14:29:00.000Z' });
  let r = await checkHealth({ store, now: NOW, rules: rulesOnly('writes') });
  assert.deepEqual(keys(r), ['writes']);
  assert.match(r.alerts[0].text, /3 writes failed since the last success \(MongoNetworkError ECONNREFUSED\)/);
  // The in-memory record of the collector's own process wins over the store's.
  r = await checkHealth({ store, now: NOW, rules: rulesOnly('writes'), health: { lastWrite: '2026-10-09T13:00:00.000Z', writeErrors: 0, lastReport: '2026-10-09T14:29:00.000Z' } });
  assert.match(r.alerts[0].text, /Reports arrive but nothing was written for over 30 minutes/);
  r = await checkHealth({ store, now: NOW, rules: rulesOnly('writes'), health: { lastWrite: '2026-10-09T14:29:00.000Z', writeErrors: 0, lastReport: '2026-10-09T14:29:00.000Z' } });
  assert.deepEqual(keys(r), []);
});

test('(e) a 404 spike, and internal broken links that are new', async () => {
  const days = Object.fromEntries(FRIDAYS.map((d) => [d, { nf: { '/wp-login%2Ephp': 5 }, nfin: { '/old-page': 1 } }]));
  days[TODAY] = { nf: { '/a': 30, '/b': 20 }, nfin: { '/old-page': 1, '/docs/v1%2E2': 2 } };
  const r = await checkHealth({ store: storeWith(days), now: NOW, rules: rulesOnly('notFound') });
  assert.deepEqual(keys(r).sort(), ['brokenLinks', 'notFound']);
  assert.match(r.alerts.find((a) => a.rule === 'notFound').text, /404s today: 50, a whole Friday usually has 5/);
  const broken = r.alerts.find((a) => a.rule === 'brokenLinks').text;
  assert.match(broken, /\/docs\/v1\.2/);
  assert.ok(!broken.includes('/old-page'), 'a broken link seen before is not new');
  // A small count is no spike, however it compares.
  days[TODAY] = { nf: { '/a': 12 } };
  assert.deepEqual(keys(await checkHealth({ store: storeWith(days), now: NOW, rules: rulesOnly('notFound') })), []);
});

test('once a day per rule, "Still:" on the next day, and a recovered line when it clears', async () => {
  const days = Object.fromEntries(FRIDAYS.map((d) => [d, { nf: { '/x': 5 } }]));
  days[TODAY] = { nf: { '/x': 60 } };
  const store = storeWith(days);
  const rules = rulesOnly('notFound');
  let r = await checkHealth({ store, now: NOW, rules });
  assert.deepEqual(keys(r), ['notFound']);
  r = await checkHealth({ store, now: new Date('2026-10-09T15:30:00Z'), rules, state: r.state });
  assert.deepEqual(keys(r), [], 'once a day');
  assert.deepEqual(Object.keys(r.state.active), ['notFound']);
  // Saturday: still failing (spike on that day too) → one reminder.
  const sat = addDays(TODAY, 1);
  store.daily.set(`${sat} *`, { _id: `${sat} *`, day: sat, path: '*', nf: { '/x': 80 } });
  for (const d of [1, 2, 3, 4].map((k) => addDays(sat, -7 * k))) store.daily.set(`${d} *`, { _id: `${d} *`, day: d, path: '*', nf: { '/x': 5 } });
  r = await checkHealth({ store, now: new Date('2026-10-10T09:00:00Z'), rules, state: r.state });
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].text, /^Still: /);
  // Cleared.
  store.daily.set(`${sat} *`, { _id: `${sat} *`, day: sat, path: '*', nf: { '/x': 3 } });
  r = await checkHealth({ store, now: new Date('2026-10-10T10:00:00Z'), rules, state: r.state });
  assert.deepEqual(keys(r), []);
  assert.equal(r.recovered.length, 1);
  assert.match(r.recovered[0].text, /Recovered: 404s are back to usual \(alerting since 2026-10-09 14:30 UTC\)/);
  assert.deepEqual(r.state.active, {});
});

test('quiet hours: nothing evaluated or posted, the state unchanged; then it alerts', async () => {
  const days = Object.fromEntries(FRIDAYS.map((d) => [d, { nf: { '/x': 5 } }]));
  days[TODAY] = { nf: { '/x': 60 } };
  const prior = { active: { low: { since: '2026-10-08T10:00:00.000Z', sent: '2026-10-08' } } };
  const rules = { ...rulesOnly('notFound'), quietHours: { from: 22, to: 15 } };
  const r = await checkHealth({ store: storeWith(days), now: NOW, rules, state: prior });
  assert.equal(r.quiet, true);
  assert.deepEqual([r.alerts, r.recovered], [[], []]);
  assert.deepEqual(r.state, prior);
  const later = await checkHealth({ store: storeWith(days), now: new Date('2026-10-09T15:05:00Z'), rules, state: prior });
  assert.deepEqual(keys(later), ['notFound']);
  assert.deepEqual(later.state.active.low, prior.active.low, 'a rule that did not run neither recovers nor fails');
});

test('a store that cannot be read is an alert of its own', async () => {
  const store = { totals: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:27017 user=x'), { name: 'MongoServerSelectionError' }); } };
  const r = await checkHealth({ store, now: NOW });
  assert.deepEqual(keys(r), ['store']);
  assert.match(r.alerts[0].text, /MongoServerSelectionError/);
  assert.ok(!r.alerts[0].text.includes('10.0.0.5'), 'the error class only, never its message');
});

test('alerts are escaped for Slack, go to the ops channel only, and post nothing when all is well', async () => {
  const text = alertText({ alerts: [{ rule: 'x', severity: 'critical', text: 'Goal "<!channel>" & <https://evil.example|click>' }], recovered: [] }, { site: 'a<b>' });
  assert.ok(!text.includes('<!channel>') && !text.includes('<https://'), text);
  assert.ok(text.includes('&lt;!channel&gt;" &amp; &lt;https'), text);
  const fetch = fakeFetch([{ json: { ok: true, ts: '1.2' } }]);
  const alerts = [{ rule: 'writes', severity: 'critical', text: 'boom' }];
  assert.equal(await postAlerts({ alerts, token: 'xoxb-t', channel: 'C0OPS', fetch }), '1.2');
  assert.equal(JSON.parse(fetch.calls[0].body).channel, 'C0OPS');
  await assert.rejects(postAlerts({ alerts, token: 'xoxb-t', channel: 'C0VISITS', visitsChannel: 'C0VISITS', fetch }), /ops channel/);
  assert.equal(await postAlerts({ alerts: [], recovered: [], token: 'xoxb-t', channel: 'C0OPS', fetch }), null);
  assert.equal(fetch.calls.length, 1);
});

test('the collector counts visits per hour of the day (hourly: false turns it off)', async () => {
  const req = (body) => new Request('https://example.com/api/k', { method: 'POST', headers: { origin: 'https://example.com', 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36' }, body: JSON.stringify(body) });
  const store = memoryStore();
  await createCollector({ hosts: ['example.com'], store, timeZone: 'UTC' })(req({ p: '/', en: 1, r: '', u: {}, l: 'en' }));
  const doc = [...store.daily.values()].find((d) => d.path === '*');
  assert.deepEqual(doc.hour, { [String(new Date().getUTCHours()).padStart(2, '0')]: 1 });
  const off = memoryStore();
  await createCollector({ hosts: ['example.com'], store: off, hourly: false })(req({ p: '/', en: 1, r: '', u: {}, l: 'en' }));
  assert.equal([...off.daily.values()].find((d) => d.path === '*').hour, undefined);
});

// --- The collector's health record ------------------------------------------------------

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const report = () => new Request('https://example.com/api/k', { method: 'POST', headers: { origin: 'https://example.com', 'user-agent': UA }, body: JSON.stringify({ p: '/' }) });
const tick = () => new Promise((r) => setTimeout(r, 20));

test('health: a successful write is recorded in memory and in the store, off the request', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  for (const make of [() => memoryStore(), async () => fileStore(await mkdtemp(tmpdir() + '/sectionsight-h-')), () => mongoStore(fakeMongo().db)]) {
    const store = await make();
    const collect = createCollector({ hosts: ['example.com'], store });
    assert.equal((await collect(report())).status, 204);
    await tick();
    const h = collect.health();
    assert.ok(h.lastWrite && h.writeErrors === 0 && h.lastError === null && h.reports === 1, JSON.stringify(h));
    assert.equal(new Date(h.lastWrite).getSeconds(), 0, 'to the minute');
    const saved = await readHealth(store);
    assert.equal(saved?.lastWrite, h.lastWrite, 'the store keeps it too');
  }
});

test('health: a failing store still answers 204; the record counts failures by class, never the message', async () => {
  let fail = true;
  const saved = [];
  const store = {
    async write() {
      if (fail) throw Object.assign(new Error('E11000 duplicate key: { email: "jane@example.com" }'), { name: 'MongoServerError', code: 11000 });
    },
    async saveHealth(h) { saved.push(h); },
    async health() { return saved[saved.length - 1] ?? null; },
  };
  const errors = [];
  const collect = createCollector({ hosts: ['example.com'], store, onError: (e) => errors.push(e) });
  for (let i = 0; i < 3; i++) assert.equal((await collect(report())).status, 204);
  await tick();
  const h = collect.health();
  assert.equal(h.writeErrors, 3);
  assert.equal(h.lastError, 'MongoServerError 11000');
  assert.ok(!JSON.stringify(saved).includes('jane@'), 'no data from the message');
  assert.ok(saved.some((h) => h.writeErrors === 1), 'the first failure is written at once');
  assert.equal(errors.length, 1, 'logged at most once a minute');
  const r = await checkHealth({ store: { totals: async () => ({}), health: store.health }, now: new Date(), rules: rulesOnly('writes') });
  assert.deepEqual(keys(r), ['writes']);
  // Recovery is written at once too.
  fail = false;
  await collect(report());
  await tick();
  assert.equal(saved[saved.length - 1].writeErrors, 0);
  assert.equal(errorClass({ name: 'x y', code: 'a b' }), 'Error');
});

test('health: a store whose health write hangs never holds up an answer', async () => {
  const store = { async write() {}, saveHealth: () => new Promise(() => {}) };
  const collect = createCollector({ hosts: ['example.com'], store });
  const res = await Promise.race([collect(report()), new Promise((r) => setTimeout(() => r('timeout'), 500))]);
  assert.equal(res.status, 204);
  assert.equal((await collect(report())).status, 204);
});

test('analyticsEngineReader: totals and the last write over the SQL API (stand-in fetch)', async () => {
  const fetch = fakeFetch((call) => ({
    json: call.body.includes('max(timestamp)')
      ? { meta: [], data: [{ last: '2026-10-09 14:28:41' }], rows: 1 }
      : { meta: [], data: [{ path: '*', key: 'visits', n: 12 }, { path: '*', key: 'hour.09', n: 3 }, { path: '/', key: 'views', n: 20 }, { path: '*', key: '__proto__.x', n: 1 }], rows: 3 },
  }));
  const ae = analyticsEngineReader({ accountId: 'a'.repeat(32), apiToken: 'tok', dataset: 'EVENTS', fetch });
  const t = await ae.totals('2026-10-09');
  assert.equal(t['2026-10-09 *'].hour['09'], 3);
  assert.equal(t['2026-10-09 /'].views, 20);
  assert.equal({}.x, undefined);
  assert.match(fetch.calls[0].body, /WHERE blob1 = '2026-10-09' AND blob4 = ''/);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(await ae.health(), { lastWrite: '2026-10-09T14:28:00.000Z', writeErrors: 0, lastError: null });
  await assert.rejects(ae.totals("2026-10-09' OR 1=1"), /YYYY-MM-DD/);
  assert.throws(() => analyticsEngineReader({ accountId: 'a'.repeat(32), dataset: 'x; drop' }), /plain name/);
});

// --- Writes that stop, seen from outside the collector ------------------------------------

/** The same weekday (and the day before) of four earlier weeks with 6 visits every hour. */
function baselineStore(now = NOW) {
  const today = new Date(now).toISOString().slice(0, 10);
  const days = [1, 2, 3, 4].flatMap((k) => [addDays(today, -7 * k), addDays(today, -7 * k - 1)]);
  return storeWith(Object.fromEntries(days.map((d) => [d, busy(6)])));
}

test('(d) a store whose writes hang: the stored record shows reports without writes, and a later check alerts', async () => {
  const saved = [];
  const later = new Date(Date.now() + 40 * 60_000);
  const store = baselineStore(later);
  const write = store.write.bind(store);
  let hang = false;
  store.write = (x) => (hang ? new Promise(() => {}) : write(x));
  const save = store.saveHealth.bind(store);
  store.saveHealth = async (h) => (saved.push(h), save(h));
  const collect = createCollector({ hosts: ['example.com'], store, healthEveryMs: 0 });
  await collect(report());
  await tick();
  hang = true;
  collect(report());
  collect(report());
  await tick();
  assert.equal(saved[saved.length - 1].reports, 3, 'reports are saved too, not only writes');
  // A separate job, 40 minutes later.
  const r = await checkHealth({ store, now: later, rules: rulesOnly('writes') });
  assert.deepEqual(keys(r), ['writes'], JSON.stringify(r));
  assert.match(r.alerts[0].text, /No write stored since .* the same hours usually bring \d+ visits/);
});

test('(d) serverless: the collector instance is gone, a separate checker alerts on an old last write; a tiny site does not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW }); // the store prunes records by the wall clock
  const store = baselineStore();
  await store.saveHealth({ instance: 'a1', savedAt: '2026-10-09T06:00:00.000Z', lastWrite: '2026-10-09T06:00:00.000Z', lastReport: '2026-10-09T06:00:00.000Z', writeErrors: 0 });
  const r = await checkHealth({ store, now: NOW, rules: rulesOnly('writes') });
  assert.deepEqual(keys(r), ['writes']);
  const tiny = storeWith(Object.fromEntries(FRIDAYS.map((d) => [d, busy(0.1)])));
  await tiny.saveHealth({ instance: 'a1', savedAt: '2026-10-09T06:00:00.000Z', lastWrite: '2026-10-09T06:00:00.000Z', writeErrors: 0 });
  assert.deepEqual(keys(await checkHealth({ store: tiny, now: NOW, rules: rulesOnly('writes') })), []);
});

test('(d) Analytics Engine: an 8-day-old newest data point alerts when those hours usually bring visits', async () => {
  const fetch = fakeFetch((call) => {
    if (call.body.includes('max(timestamp)')) return { json: { data: [{ last: '2026-10-01 10:00:00' }] } };
    const day = /blob1 = '([^']+)'/.exec(call.body)[1];
    return { json: { data: FRIDAYS.includes(day) ? Array.from({ length: 24 }, (_, h) => ({ path: '*', key: `hour.${String(h).padStart(2, '0')}`, n: 4 })) : [] } };
  });
  const ae = analyticsEngineReader({ accountId: 'a'.repeat(32), apiToken: 't', dataset: 'EVENTS', fetch });
  const r = await checkHealth({ store: ae, now: NOW, rules: rulesOnly('writes') });
  assert.deepEqual(keys(r), ['writes'], JSON.stringify(r));
  assert.match(r.alerts[0].text, /No write stored since 2026-10-01 10:00 UTC \(48 h\)/);
});

test('several instances: each keeps its record; failures of an instance gone for hours stop counting', async () => {
  const { mergeHealth } = await import('../skills/sectionsight/assets/collector.mjs');
  const now = Date.parse('2026-10-09T14:30:00Z');
  const m = mergeHealth([
    { instance: 'a', savedAt: '2026-10-09T14:29:00Z', lastWrite: '2026-10-09T14:29:00.000Z', writeErrors: 0 },
    { instance: 'b', savedAt: '2026-10-09T14:20:00Z', lastWrite: '2026-10-09T14:00:00.000Z', writeErrors: 4, lastError: 'MongoNetworkError', delDropped: 1 },
    { instance: 'c', savedAt: '2026-10-09T06:00:00Z', lastWrite: '2026-10-09T06:00:00.000Z', writeErrors: 9, lastError: 'Old', delDropped: 5 },
  ], now);
  assert.deepEqual([m.lastWrite, m.writeErrors, m.lastError, m.delDropped, m.instances], ['2026-10-09T14:29:00.000Z', 4, 'MongoNetworkError', 1, 2]);
  for (const store of [memoryStore(), mongoStore(fakeMongo().db), fileStore(await (await import('node:fs/promises')).mkdtemp((await import('node:os')).tmpdir() + '/sectionsight-mi-'))]) {
    await store.saveHealth({ instance: 'a', savedAt: new Date().toISOString(), lastWrite: '2026-10-09T14:29:00.000Z', writeErrors: 0 });
    await store.saveHealth({ instance: 'b', savedAt: new Date().toISOString(), lastWrite: '2026-10-09T14:00:00.000Z', writeErrors: 2, lastError: 'X' });
    const h = await store.health();
    assert.deepEqual([h.lastWrite, h.writeErrors, h.instances], ['2026-10-09T14:29:00.000Z', 2, 2], 'last writer does not win');
  }
});

test('deletions: a dropped deletion request alerts for a day; the webhook path also refuses the visits webhook', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const store = memoryStore();
  await store.saveHealth({ instance: 'a', savedAt: '2026-10-09T14:00:00.000Z', lastWrite: '2026-10-09T14:29:00.000Z', lastReport: '2026-10-09T14:29:00.000Z', writeErrors: 0, delDropped: 2, lastDelDrop: '2026-10-09T13:00:00.000Z' });
  const r = await checkHealth({ store, now: NOW, rules: rulesOnly('writes') });
  assert.deepEqual(keys(r), ['deletions']);
  assert.match(r.alerts[0].text, /deletion requests were dropped \(2;/);
  const later = await checkHealth({ store, now: new Date('2026-10-10T14:00:00Z'), rules: rulesOnly('writes'), state: r.state });
  assert.equal(later.recovered[0]?.rule, 'deletions');
  const fetch = fakeFetch([{ status: 200 }]);
  await assert.rejects(postAlerts({ alerts: r.alerts, webhook: 'https://hooks.slack.com/services/V', visitsWebhook: 'https://hooks.slack.com/services/V', fetch }), /ops webhook/);
  await postAlerts({ alerts: r.alerts, webhook: 'https://hooks.slack.com/services/OPS', visitsWebhook: 'https://hooks.slack.com/services/V', fetch });
  assert.equal(fetch.calls.length, 1);
});
