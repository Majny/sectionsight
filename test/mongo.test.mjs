/**
 * mongoStore against a real mongod (mongodb-memory-server), when one is at
 * hand: SECTIONSIGHT_MONGO_MODULES=<a directory whose node_modules has mongodb and
 * mongodb-memory-server-core>. Skipped otherwise; the stand-in in fakes.mjs
 * covers the logic in every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCollector, mongoStore } from '../skills/sectionsight/assets/collector.mjs';
import { enforceRetention, retentionStatus } from '../skills/sectionsight/assets/retention.mjs';
import { exportVisit, deleteVisit } from '../skills/sectionsight/assets/dsar.mjs';
import { checkHealth } from '../skills/sectionsight/assets/health.mjs';

const dir = process.env.SECTIONSIGHT_MONGO_MODULES;
let mods = null;
if (dir) {
  const require = createRequire(path.join(dir, 'noop.js'));
  try {
    mods = { mms: await import(require.resolve('mongodb-memory-server-core')), mongodb: await import(require.resolve('mongodb')) };
  } catch {}
}

test('mongoStore on a real mongod: totals, health per instance, retention, a visitor\'s deletion', { skip: mods ? false : 'set SECTIONSIGHT_MONGO_MODULES to run it', timeout: 120_000 }, async () => {
  const { MongoMemoryServer } = mods.mms;
  const { MongoClient } = mods.mongodb;
  const srv = await MongoMemoryServer.create({ binary: { version: process.env.SECTIONSIGHT_MONGO_VERSION ?? '7.0.14' } });
  const client = await MongoClient.connect(srv.getUri(), { serverSelectionTimeoutMS: 2000 });
  try {
    const db = client.db('t');
    const store = mongoStore(db);
    await store.init();
    const tz = 'Europe/Berlin';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
    const req = (body, ip = '203.0.113.7') => new Request('https://example.test/api/k', { method: 'POST', body: JSON.stringify(body), headers: { origin: 'https://example.test', referer: 'https://example.test/', 'user-agent': ua, 'x-forwarded-for': ip } });
    const a = createCollector({ hosts: ['example.test'], store, timeZone: tz, healthEveryMs: 0, onError: () => {} });
    const b = createCollector({ hosts: ['example.test'], store, timeZone: tz, healthEveryMs: 0 });
    await a(req({ p: '/docs/v1.2', e: 'nf', d: { r: 'internal' } }));
    await a(req({ p: '/x', en: 1, r: '', u: {}, l: 'en', vi: '1111111111111111', v: '2222222222222222' }));
    await b(req({ p: '/x', e: 'read', d: { s: 'intro' }, vi: '1111111111111111', v: '2222222222222222' }));
    await b(req({ p: '/y', en: 1, r: '', u: {}, l: 'en', vi: '3333333333333333', v: '4444444444444444' }));
    await new Promise((r) => setTimeout(r, 300));
    const t = await store.totals(day);
    assert.deepEqual(t[`${day} *`].nfin, { '/docs/v1%2E2': 1 }, 'a dotted path stays one key');
    assert.equal(t[`${day} *`].visits, 2);
    assert.equal(Object.values(t[`${day} *`].hour).reduce((x, y) => x + y, 0), 2);
    const h = await store.health();
    assert.equal(h.instances, 2, 'one record per collector instance');
    assert.ok(h.lastWrite && h.writeErrors === 0, JSON.stringify(h));

    await db.collection('web_daily').insertOne({ _id: '2020-01-01 *', day: '2020-01-01', path: '*', visits: 1, at: new Date('2020-01-01T12:00:00Z') });
    await db.collection('web_events').insertOne({ at: new Date('2020-01-01'), day: '2020-01-01', visit: 'ffffffffffffffff' });
    assert.equal((await retentionStatus(store, { totalsDays: 730, rowsDays: 180, timeZone: tz })).rowsOk, false);
    const r = await enforceRetention({ store, timeZone: tz });
    assert.deepEqual([r.totals, r.rows], [1, 1]);
    assert.equal((await retentionStatus(store, { totalsDays: 730, rowsDays: 180, timeZone: tz })).rowsOk, true);

    assert.equal((await exportVisit(store, '1111111111111111')).rows.length, 2);
    await a(req({ del: '1111111111111111' }, '198.51.100.4'));
    assert.equal(await db.collection('web_events').countDocuments({ visit: '1111111111111111' }), 0);
    assert.equal(await db.collection('web_events').countDocuments({ visit: '3333333333333333' }), 1, 'the other visit stays');
    assert.deepEqual(await deleteVisit(store, '3333333333333333'), { deleted: 1 });

    // An outage: writes fail, the in-memory record says so, the check alerts.
    await srv.stop({ doCleanup: false, force: true });
    await a(req({ p: '/z', en: 1, r: '', u: {}, l: 'en' }, '192.0.2.9'));
    assert.ok(a.health().writeErrors >= 1, JSON.stringify(a.health()));
    const c = await checkHealth({ store, timeZone: tz, health: a.health(), rules: { goal: false, notFound: false, silence: false, low: false } });
    assert.ok(c.alerts.some((x) => x.rule === 'store' || x.rule === 'writes'), JSON.stringify(c.alerts));
  } finally {
    await client.close(true).catch(() => {});
    await srv.stop().catch(() => {});
  }
});
