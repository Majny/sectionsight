/**
 * Retention (retention.mjs), a visitor's own data (dsar.mjs) and the
 * collector's { del } requests, for every store: memory, files, SQL (SQLite
 * through node:sqlite, and the Postgres placeholders) and Mongo (a stand-in).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createCollector, memoryStore, fileStore, mongoStore, sqlStore, analyticsEngineStore, dailyIds, dayOf } from '../skills/sectionsight/assets/collector.mjs';
import { enforceRetention, retentionStatus, deleteOldSlackLines } from '../skills/sectionsight/assets/retention.mjs';
import { exportVisit, deleteVisit, deletePostHogRecordings } from '../skills/sectionsight/assets/dsar.mjs';
import { planVisits, rememberPosted } from '../skills/sectionsight/assets/visits.mjs';
import { fakeMongo, sqliteQuery, fakeFetch } from './fakes.mjs';

const NOW = new Date('2026-10-09T12:00:00Z');
const V1 = '0123456789abcdef';
const V2 = 'fedcba9876543210';
const row = (day, visit, extra = {}) => ({ at: new Date(`${day}T10:00:00Z`), day, visit, view: 'aaaaaaaaaaaaaaaa', path: '/', e: 'view', d: { of: 2 }, ...extra });
const incs = (day) => [{ _id: `${day} /`, day, path: '/', inc: { views: 1, 'sec.intro.s': 4 } }, { _id: `${day} *`, day, path: '*', inc: { visits: 1, 'hour.10': 1 } }];

const sqlite = await sqliteQuery();
async function stores() {
  const out = [
    ['memory', memoryStore()],
    ['files', fileStore(await mkdtemp(tmpdir() + '/sectionsight-ret-'))],
    ['mongo', mongoStore(fakeMongo().db)],
  ];
  if (sqlite) {
    const s = sqlStore({ dialect: 'sqlite', query: (await sqliteQuery()).query });
    await s.init();
    out.push(['sqlite', s]);
  }
  return out;
}
// Old (3 years), middle (200 days) and recent data, two visits.
async function fill(store) {
  for (const [day, visit] of [['2023-09-01', V1], ['2026-03-20', V1], ['2026-10-08', V1], ['2026-10-09', V2], ['2026-10-09', V1]]) {
    await store.write({ incs: incs(day), row: row(day, visit, visit === V1 && day === '2026-10-08' ? { replay: '0199aa00-1111-7222-8333-944445555666' } : {}) });
  }
}

test('retention: old totals and rows are deleted from every store; the status shows the oldest day', async () => {
  if (!sqlite) console.log('node:sqlite is missing: the SQLite store is not tested');
  for (const [name, store] of await stores()) {
    await fill(store);
    const before = await retentionStatus(store, { totalsDays: 730, rowsDays: 180, now: NOW });
    assert.deepEqual([before.oldestTotalsDay, before.oldestRowDay, before.totalsOk, before.rowsOk], ['2023-09-01', '2023-09-01', false, false], name);
    const r = await enforceRetention({ store, totalsDays: 730, rowsDays: 180, now: NOW });
    // Totals are counted as the store keeps them: documents, day files or key rows.
    assert.deepEqual([r.totals, r.rows, r.totalsBefore, r.rowsBefore], [{ memory: 2, files: 1, mongo: 2, sqlite: 4 }[name], 2, '2024-10-09', '2026-04-12'], name);
    const after = await retentionStatus(store, { totalsDays: 730, rowsDays: 180, now: NOW });
    assert.deepEqual([after.oldestTotalsDay, after.oldestRowDay, after.totalsOk, after.rowsOk], ['2026-03-20', '2026-10-08', true, true], name);
    const t = await store.totals('2026-10-09');
    assert.equal(t['2026-10-09 /'].views, 2, `${name}: recent totals stay`);
    assert.equal(t['2026-10-09 *'].hour['10'], 2, `${name}: nested counters`);
  }
});

test('retention: Analytics Engine says it cannot delete; sqlStore uses $n placeholders for Postgres', async () => {
  assert.match((await enforceRetention({ store: analyticsEngineStore({ writeDataPoint() {} }), now: NOW })).unsupported, /3 months/);
  await assert.rejects(enforceRetention({ store: memoryStore(), totalsDays: 0 }), /positive/);
  const seen = [];
  const pg = sqlStore({ dialect: 'postgres', query: async (sql, params) => (seen.push([sql, params]), sql.startsWith('select count') ? [{ n: '3' }] : []) });
  const r = await pg.deleteBefore({ totalsBefore: '2024-10-09', rowsBefore: '2026-04-12' });
  assert.deepEqual(r, { totals: 3, rows: 3 });
  assert.ok(seen.some(([sql, p]) => sql === 'delete from web_daily where day < $1' && p[0] === '2024-10-09'), JSON.stringify(seen));
  assert.ok(seen.some(([sql]) => sql === 'delete from web_events where day < $1'));
  await pg.write({ incs: incs('2026-10-09'), row: row('2026-10-09', V1) });
  assert.ok(seen.some(([sql]) => /values \(\$1, \$2, \$3, \$4\) on conflict \(day, path, key\) do update set n = web_daily\.n \+ excluded\.n/.test(sql)));
  assert.ok(seen.some(([sql, p]) => /^insert into web_events .* values \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9\)$/.test(sql) && p[2] === V1));
});

test('dsar: export and delete one visit in every store, nothing else touched', async () => {
  for (const [name, store] of await stores()) {
    await fill(store);
    const out = await exportVisit(store, V1);
    assert.equal(out.rows.length, 4, name);
    assert.ok(out.rows.every((r) => r.visit === V1 && r.path === '/' && r.d.of === 2), name);
    assert.deepEqual(out.replays, ['0199aa00-1111-7222-8333-944445555666'], name);
    assert.deepEqual(await deleteVisit(store, V1), { deleted: 4 }, name);
    assert.equal((await exportVisit(store, V1)).rows.length, 0, name);
    assert.equal((await exportVisit(store, V2)).rows.length, 1, `${name}: the other visit stays`);
    assert.equal((await store.totals('2026-10-09'))['2026-10-09 /'].views, 2, `${name}: totals have no id and stay`);
  }
  await assert.rejects(exportVisit(memoryStore(), 'not-an-id'), /16 hex/);
  assert.ok((await deleteVisit(analyticsEngineStore({ writeDataPoint() {} }), V1)).unsupported);
});

test('dsar: PostHog recordings only through the URL the owner checked, with a personal key', async () => {
  await assert.rejects(deletePostHogRecordings({ ids: ['x'], endpoint: 'https://eu.posthog.com/api/whatever', personalApiKey: 'k' }), /\{id\}/);
  await assert.rejects(deletePostHogRecordings({ ids: ['x'], endpoint: 'https://eu.posthog.com/api/environments/1/session_recordings/{id}/' }), /personal API key/);
  const fetch = fakeFetch((call) => ({ status: call.url.includes('0199aa00') ? 204 : 500 }));
  const r = await deletePostHogRecordings({ ids: ['0199aa00-1111-7222-8333-944445555666', 'abcdefgh-0000', '../../x'], endpoint: 'https://eu.posthog.com/api/environments/1/session_recordings/{id}/', personalApiKey: 'phx_k', fetch });
  assert.deepEqual(r.deleted, ['0199aa00-1111-7222-8333-944445555666']);
  assert.deepEqual(r.failed.map((f) => f.status), [500, 'invalid id']);
  assert.equal(fetch.calls[0].method, 'DELETE');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer phx_k');
});

test('Slack: old visit lines are deleted by their ts, with a retry after a rate limit; state pruned', async () => {
  const { state } = planVisits([], null, NOW);
  rememberPosted(state, { channel: 'C0VISITS', ts: '1700000000.000100', at: '2026-08-01T10:00:00Z' });
  rememberPosted(state, { channel: 'C0VISITS', ts: '1700000000.000200', at: '2026-08-02T10:00:00Z' });
  rememberPosted(state, { channel: 'C0VISITS', ts: '1700000000.000300', at: '2026-10-08T10:00:00Z' });
  rememberPosted(state, { channel: 'C0VISITS', ts: 'nonsense', at: '2026-08-01T10:00:00Z' });
  assert.equal(state.posted.length, 3, 'a ts that is not one is not kept');
  // The next poll carries them over, past keepDays.
  const carried = planVisits([], state, new Date('2026-10-09T12:00:00Z')).state;
  assert.equal(carried.posted.length, 3);
  const sleeps = [];
  const fetch = fakeFetch([
    { status: 429, headers: { 'retry-after': '2' } },
    { json: { ok: true } },
    { json: { ok: false, error: 'message_not_found' } },
  ]);
  const r = await deleteOldSlackLines({ state: carried, slackDays: 30, token: 'xoxb-t', now: NOW, fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [2000], 'waited Retry-After');
  assert.deepEqual(fetch.calls.map((c) => JSON.parse(c.body).ts), ['1700000000.000100', '1700000000.000100', '1700000000.000200']);
  assert.ok(fetch.calls.every((c) => c.url === 'https://slack.com/api/chat.delete'), 'never the channel history');
  assert.deepEqual([r.deleted, r.failed, r.stopped], [2, 0, null]);
  assert.deepEqual(r.state.posted.map((p) => p.ts), ['1700000000.000300'], 'the recent line stays');
});

test('Slack: an error "ratelimited" answer backs off and retries; an entry without a date counts as old', async () => {
  const state = { posted: [{ channel: 'C1', ts: '1.1', at: '2026-01-01T00:00:00Z' }, { channel: 'C1', ts: '2.2' }, { channel: 'C1', ts: '3.3', at: '2026-10-08T00:00:00Z' }] };
  let n = 0;
  const sleeps = [];
  const fetch = fakeFetch(() => (n++ === 0 ? { json: { ok: false, error: 'ratelimited' }, headers: { 'retry-after': '3' } } : { json: { ok: true } }));
  const r = await deleteOldSlackLines({ state, token: 't', now: NOW, fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [3000]);
  assert.deepEqual(fetch.calls.map((c) => JSON.parse(c.body).ts), ['1.1', '1.1', '2.2']);
  assert.deepEqual([r.deleted, r.state.posted.map((p) => p.ts)], [2, ['3.3']]);
});

test('retention: the cutoff is a day in the collector\'s time zone, around midnight on both sides of UTC', async () => {
  for (const [timeZone, iso, keep] of [
    ['Europe/Berlin', '2026-10-08T22:30:00Z', ['2024-10-09', '2024-10-10']], // 00:30 on 9 October in Berlin
    ['Pacific/Honolulu', '2026-10-10T09:00:00Z', ['2024-10-09', '2024-10-10']], // 23:00 on 9 October in Honolulu
  ]) {
    const s = memoryStore();
    for (const day of ['2024-10-07', '2024-10-08', '2024-10-09', '2024-10-10']) s.daily.set(`${day} *`, { day, path: '*', visits: 1 });
    const r = await enforceRetention({ store: s, now: new Date(iso), totalsDays: 730, timeZone });
    assert.equal(r.totalsBefore, '2024-10-09', timeZone);
    assert.deepEqual([...s.daily.values()].map((d) => d.day), keep, timeZone);
    assert.equal((await retentionStatus(s, { totalsDays: 730, now: new Date(iso), timeZone })).totalsOk, true);
    const dir = await mkdtemp(tmpdir() + '/sectionsight-tz-');
    const fs = fileStore(dir, { dailyDays: 730, timeZone });
    for (const day of ['2024-10-08', '2024-10-09']) await fs.write({ incs: [{ _id: `${day} *`, day, path: '*', inc: { visits: 1 } }] });
    await fs.purge(new Date(iso));
    assert.equal((await fs.oldest()).totalsDay, '2024-10-09', `files, ${timeZone}`);
  }
});

test('Slack: a token problem stops the run and drops nothing; endless rate limits keep the rest', async () => {
  const state = { posted: [{ channel: 'C1', ts: '1.1', at: '2026-01-01T00:00:00Z' }, { channel: 'C1', ts: '1.2', at: '2026-01-02T00:00:00Z' }] };
  let r = await deleteOldSlackLines({ state, token: 't', now: NOW, fetch: fakeFetch([{ json: { ok: false, error: 'invalid_auth' } }]) });
  assert.deepEqual([r.deleted, r.stopped, r.state.posted.length], [0, 'invalid_auth', 2]);
  const fetch = fakeFetch([{ status: 429, headers: { 'retry-after': '1' } }]);
  r = await deleteOldSlackLines({ state, token: 't', now: NOW, fetch, sleep: async () => {}, maxRetries: 2 });
  assert.deepEqual([r.deleted, r.stopped, r.state.posted.length, fetch.calls.length], [0, 'ratelimited', 2, 3]);
  r = await deleteOldSlackLines({ state, token: 't', now: NOW, fetch: fakeFetch([{ json: { ok: false, error: 'cant_delete_message' } }]) });
  assert.deepEqual([r.failed, r.state.posted.length], [2, 2]);
});

// --- The collector's { del } requests ----------------------------------------------------------

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
function req(body, headers = {}) {
  return new Request('https://example.com/api/k', {
    method: 'POST',
    headers: { origin: 'https://example.com', 'user-agent': UA, 'content-type': 'text/plain;charset=UTF-8', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function twoVisits(opts = {}) {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, ...opts });
  await collect(req({ p: '/', en: 1, r: '', u: {}, l: 'en', vi: V1, v: 'aaaaaaaaaaaaaaaa' }));
  await collect(req({ p: '/pricing', vi: V1, v: 'bbbbbbbbbbbbbbbb' }));
  await collect(req({ p: '/', vi: V2, v: 'cccccccccccccccc' }));
  return { store, collect };
}

test('collector del: only the rows of that visit go; 204 whether or not it exists', async () => {
  const { store, collect } = await twoVisits();
  const totals = JSON.stringify([...store.daily.values()]);
  assert.equal((await collect(req({ del: '1111111111111111' }))).status, 204);
  assert.equal(store.rows.length, 3, 'unknown id: nothing changes');
  assert.equal((await collect(req({ del: V1 }))).status, 204);
  assert.deepEqual(store.rows.map((r) => r.visit), [V2]);
  assert.equal(JSON.stringify([...store.daily.values()]), totals, 'a deletion is neither a report nor a change to the totals');
});

test('collector del: other origins, extra fields and malformed ids are ignored; GPC does not stop a deletion', async () => {
  const { store, collect } = await twoVisits();
  for (const r of [req({ del: V1 }, { origin: 'https://evil.example' }), req({ del: V1, p: '/' }), req({ del: V1.toUpperCase() }), req({ del: [V1] }), req(`{"del":"${V1}"`)]) {
    assert.equal((await collect(r)).status, 204);
  }
  assert.equal(store.rows.length, 3);
  assert.equal((await collect(req({ del: V2 }, { 'sec-gpc': '1' }))).status, 204);
  assert.deepEqual(store.rows.map((r) => r.visit), [V1, V1]);
});

test('collector del: its own limit per address, counted when it drops one; deletion: false turns it off; never in ids never', async () => {
  const { store, collect } = await twoVisits();
  // A busy shared address: the reports' limit (150) is used up first.
  for (let i = 0; i < 160; i++) await collect(req({ p: '/', vi: V2, v: 'cccccccccccccccc' }));
  await collect(req({ del: V2 }));
  assert.ok(!store.rows.some((r) => r.visit === V2), 'the reports\' throttle does not stop a deletion');
  for (let i = 0; i < 29; i++) await collect(req({ del: '1111111111111111' }));
  assert.equal(collect.health().delDropped, 0);
  await collect(req({ del: V1 }));
  assert.equal(store.rows.length, 2, 'the 31st deletion request in the window is dropped');
  assert.equal(collect.health().delDropped, 1, 'and counted');
  await collect(req({ del: V1 }, { 'cf-connecting-ip': '198.51.100.4' }));
  assert.equal(store.rows.length, 0, 'another address is not throttled');
  const off = await twoVisits({ deletion: false });
  await off.collect(req({ del: V1 }));
  assert.equal(off.store.rows.length, 3);
  const never = memoryStore();
  never.rows.push(row('2026-10-09', V1));
  await createCollector({ hosts: ['example.com'], store: never, ids: 'never' })(req({ del: V1 }));
  assert.equal(never.rows.length, 1);
});

test('collector del in model C: "today" deletes the requester\'s daily hash only', async () => {
  const store = memoryStore();
  const collect = createCollector({ hosts: ['example.com'], store, ids: 'always', secret: 's3cret', timeZone: 'UTC' });
  await collect(req({ p: '/', en: 1, r: '', u: {}, l: 'en', v: 'aaaaaaaaaaaaaaaa' }));
  await collect(req({ p: '/', en: 1, r: '', u: {}, l: 'en', v: 'bbbbbbbbbbbbbbbb' }, { 'cf-connecting-ip': '198.51.100.4' }));
  assert.equal(new Set(store.rows.map((r) => r.visit)).size, 2);
  const mine = (await dailyIds('s3cret', dayOf(new Date(), 'UTC'), '203.0.113.7', UA, '')).visitor;
  await collect(req({ del: mine }));
  assert.equal(store.rows.length, 2, 'a hash sent by the browser is not accepted: only "today"');
  await collect(req({ del: 'today' }));
  assert.equal(store.rows.length, 1);
  assert.notEqual(store.rows[0].visit, mine, 'the other address keeps its rows');
});
