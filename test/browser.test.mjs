/**
 * The assets together in a real browser (Playwright's Chromium), checked by
 * the skill's own verify.mjs, plus a negative control: a careless page must
 * fail it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startFixture } from './server.mjs';
import { planVisits } from '../skills/sectionsight/assets/visits.mjs';

const VERIFY = new URL('../skills/sectionsight/scripts/verify.mjs', import.meta.url).pathname;

function verify(base, extra) {
  const report = path.join(tmpdir(), `sectionsight-${process.pid}-${Math.round(performance.now())}.json`);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [VERIFY, '--url', base, '--report', report, ...extra], { cwd: new URL('..', import.meta.url).pathname });
    let out = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (out += b));
    p.on('close', async (code) => resolve({ code, out, report: JSON.parse(await readFile(report, 'utf8').catch(() => '{}')) }));
  });
}

test('consent mode with PostHog: every check passes, and the rows make Slack lines', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  try {
    // Under a production-like name: posthog-js turns some capture off on localhost.
    // /Account/settings: the private-path rule is "/…/i" in all four places.
    const r = await verify(f.named, ['--resolve', 'acme.test', '--pages', '/,/pricing', '--private', '/account/9f8e7d6c5b4a32100123,/Account/settings', '--mode', 'consent', '--posthog', '/ingest', '--rows-url', '/__store', '--privacy-page', '/privacy']);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.report.results.find((x) => x.name === 'privacy page /privacy names every recipient')?.status, 'PASS', r.out);
    for (const name of ['delete my visit data: the request carries only the visit id', 'delete my visit data: consent is withdrawn too', "delete my visit data: the visit's rows are gone"]) {
      assert.equal(r.report.results.find((x) => x.name === name)?.status, 'PASS', name + '\n' + r.out);
    }
    const probe = r.report.results.find((x) => x.name.startsWith('a token in the path'));
    assert.equal(probe?.status, 'PASS', 'the path probe ran on the 404 page: ' + r.out);
    assert.ok(r.report.results.filter((x) => x.status === 'PASS').length >= 22, r.out);
    // What reached PostHog: real events and replay, nothing of the console or the network.
    const posts = f.ingest.filter((x) => x.method === 'POST');
    assert.ok(posts.some((x) => x.path === '/e/'), 'events');
    assert.ok(posts.some((x) => x.path === '/s/'), 'replay snapshots');
    // The project asks for console and network capture. The console stays off.
    // The network plugin starts anyway (posthog-js ORs the project's switch
    // with the client's), but every entry the mask lets through is the page's
    // own navigation timing with its URL blanked: no URL, header or body.
    assert.ok(!posts.some((x) => /rrweb\/console@/.test(x.body)), 'no console capture, though the project asks for it');
    const network = posts.flatMap((x) => [...x.body.matchAll(/"plugin":"rrweb\/network@1","payload":(\{.*?\})\}/g)].map((m) => m[1]));
    for (const p of network) {
      assert.ok(!/"name":"[^"]/.test(p) && !/Headers|Body|"url"/i.test(p), 'a network entry with a URL, header or body: ' + p.slice(0, 300));
    }
    // verify.mjs reads each page for 5 s, under the default "notable" bar, and
    // with the visit id in memory each page load is its own visit: take all.
    const { lines } = planVisits(f.store().rows, null, new Date(Date.now() + 3 * 3600_000), { notable: () => true });
    assert.ok(lines.some((l) => l.line.includes('/pricing') && l.line.includes('newsletter')), JSON.stringify(lines));
  } finally {
    await f.close();
  }
});

test("'never' and 'always' modes pass too (consent.js loaded with defer)", { timeout: 300_000 }, async () => {
  for (const ids of ['never', 'always']) {
    const f = await startFixture({ ids, consentDefer: true });
    try {
      const args = ['--pages', '/,/pricing', '--private', '/account/9f8e7d6c5b4a32100123', '--mode', ids, '--posthog', '/ingest'];
      if (ids === 'always') args.push('--banner', 'no');
      const r = await verify(f.base, args);
      assert.equal(r.code, 0, `${ids}\n${r.out}`);
      if (ids === 'never') assert.equal(f.store().rows.length, 0, 'never: no rows at all');
      if (ids === 'always') assert.ok(f.store().rows.length > 0 && f.store().rows.every((x) => /^[0-9a-f]{16}$/.test(x.visit)), 'always: rows keyed by the daily hash');
    } finally {
      await f.close();
    }
  }
});

test('negative control: a tracker running on a private page fails the check', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', leakPrivate: true });
  try {
    const r = await verify(f.base, ['--pages', '/', '--private', '/account/9f8e7d6c5b4a32100123', '--mode', 'consent', '--posthog', '/ingest']);
    assert.equal(r.code, 1, r.out);
    const failed = r.report.results.filter((x) => x.status === 'FAIL').map((x) => x.name);
    assert.ok(failed.includes('private paths: no report and no PostHog request'), r.out);
  } finally {
    await f.close();
  }
});

test('negative control: a careless page fails the check', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', bad: true });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--posthog', '/ingest']);
    assert.equal(r.code, 1, r.out);
    const failed = r.report.results.filter((x) => x.status === 'FAIL').map((x) => x.name);
    for (const name of ['before consent: no cookies', 'before consent: nothing stored in the browser', 'before consent: no PostHog request', 'reports and events never carry the probe e-mail or token']) {
      assert.ok(failed.includes(name), `expected "${name}" to fail:\n${r.out}`);
    }
    const leak = r.report.results.find((x) => x.name === 'reports and events never carry the probe e-mail or token');
    assert.match(leak.detail, /collector:/, 'the probe inside a Blob beacon was read too: ' + leak.detail);
  } finally {
    await f.close();
  }
});

test('a client-side route is a new view with its own sections', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const page = await context.newPage();
    await page.goto(f.base + '/spa');
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(50 + i * 10, 200);
      await page.waitForTimeout(500);
    }
    await page.click('#go');
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(50 + i * 10, 220);
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    const daily = [...f.store().daily.values()];
    const first = daily.find((d) => d.path === '/spa');
    const next = daily.find((d) => d.path === '/spa/next');
    assert.ok(first?.views === 1 && next?.views === 1, JSON.stringify(daily));
    assert.ok(next.sec?.['next-one']?.s > 0, 'the new page was measured by its own sections: ' + JSON.stringify(next));
    assert.ok(!next.sec?.['spa-one'], 'nothing of the old page counted for the new one');
    const visits = daily.find((d) => d.path === '*');
    assert.equal(visits.visits, 1, 'a route is not a new visit');
  } finally {
    await browser.close();
    await f.close();
  }
});

async function consentedVisit(f, pages) {
  const browser = await chromium.launch();
  try {
    const probe = await browser.newPage();
    const ua = (await probe.evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const page = await context.newPage();
    await page.goto(f.base + pages[0]);
    await page.locator('button:has-text("Accept")').first().click();
    for (const p of pages) {
      await page.goto(f.base + p);
      for (let i = 0; i < 6; i++) {
        await page.mouse.move(60 + i * 10, 200);
        await page.waitForTimeout(400);
      }
    }
    await page.goto('about:blank');
    await page.waitForTimeout(500);
    return f.store().rows;
  } finally {
    await browser.close();
  }
}

test('the visit id lives for one page load by default, and spans page loads with data-visit-store="session"', { timeout: 120_000 }, async () => {
  const mem = await startFixture({ ids: 'consent' });
  try {
    const rows = await consentedVisit(mem, ['/', '/pricing']);
    const ids = new Set(rows.map((r) => r.visit));
    assert.ok(rows.some((r) => r.path === '/') && rows.some((r) => r.path === '/pricing'), JSON.stringify(rows));
    assert.ok(ids.size >= 2, 'memory: each page load has its own visit id');
  } finally {
    await mem.close();
  }
  const ses = await startFixture({ ids: 'consent', visitStore: 'session' });
  try {
    const rows = await consentedVisit(ses, ['/', '/pricing', '/']);
    const ids = new Set(rows.map((r) => r.visit));
    assert.equal(ids.size, 1, 'session: one visit across three page loads: ' + JSON.stringify([...ids]));
  } finally {
    await ses.close();
  }
});

test('negative control: PostHog without the guard\'s before_send fails the probe check', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', unsafeBeforeSend: true });
  try {
    const r = await verify(f.named, ['--resolve', 'acme.test', '--pages', '/,/pricing', '--mode', 'consent', '--posthog', '/ingest']);
    assert.equal(r.code, 1, r.out);
    const failed = r.report.results.filter((x) => x.status === 'FAIL').map((x) => x.name);
    assert.ok(failed.includes('after consent: no request carries the probe e-mail or token'), r.out);
  } finally {
    await f.close();
  }
});

test('negative control: a URL hidden in the recorded page is found inside the compressed recording', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', leakInDom: true });
  try {
    const r = await verify(f.named, ['--resolve', 'acme.test', '--pages', '/', '--mode', 'consent', '--posthog', '/ingest']);
    assert.equal(r.code, 1, r.out);
    const leak = r.report.results.find((x) => x.name === 'after consent: no request carries the probe e-mail or token');
    assert.equal(leak?.status, 'FAIL', r.out);
  } finally {
    await f.close();
  }
});

test('a rage click on a preview of typed text sends the tag only', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const bodies = [];
    context.on('request', (r) => { if (r.url().endsWith('/api/k')) bodies.push(r.postData() || ''); });
    const page = await context.newPage();
    await page.goto(f.base + '/pricing');
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'preview';
      box.textContent = 'Jane Doe, Hauptstraße 5, Berlin';
      box.style.cssText = 'padding:20px;font-size:20px';
      document.querySelector('main section').appendChild(box);
    });
    const at = await page.locator('#preview').boundingBox();
    for (let i = 0; i < 3; i++) await page.mouse.click(at.x + 30, at.y + 10, { delay: 20 });
    await page.waitForTimeout(500);
    const rage = bodies.map((b) => { try { return JSON.parse(b); } catch { return null; } }).find((b) => b?.e === 'rage');
    assert.ok(rage, 'a rage report: ' + bodies.join(' | '));
    assert.equal(rage.d.label, 'div');
  } finally {
    await browser.close();
    await f.close();
  }
});

test('negative control: a tracker that sends a token in the path fails the path probe', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', rawPaths: true });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--banner', 'no', '--settle', '0']);
    assert.equal(r.code, 1, r.out);
    const probe = r.report.results.find((x) => x.name.startsWith('a token in the path'));
    assert.equal(probe?.status, 'FAIL', r.out);
  } finally {
    await f.close();
  }
});

test('an answer stored without a date is dated on load, so it expires like any other', { timeout: 60_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('analytics-consent', 'granted');
        localStorage.removeItem('analytics-consent-at');
      }
    });
    const page = await context.newPage();
    await page.goto(f.base + '/privacy');
    const at = await page.evaluate(() => localStorage.getItem('analytics-consent-at'));
    assert.ok(at && Math.abs(Date.parse(at) - Date.now()) < 60_000, 'dated now: ' + at);
    assert.equal(await page.evaluate(() => window.analyticsConsent.get()), 'granted');
  } finally {
    await browser.close();
    await f.close();
  }
});

test('k.js with a private-path rule that does not parse measures nothing and warns', { timeout: 60_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
      window.kConfig = { skip: '/^\\/account' }; // a literal without its closing slash
    });
    const sent = [];
    const warnings = [];
    context.on('request', (r) => { if (r.url().endsWith('/api/k')) sent.push(r.url()); });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
    await page.goto(f.base + '/pricing');
    await page.mouse.move(50, 200);
    await page.waitForTimeout(1500);
    await page.goto('about:blank');
    await page.waitForTimeout(300);
    assert.equal(sent.length, 0, 'no report at all');
    assert.ok(warnings.some((w) => w.includes('[k.js]')), warnings.join(' | '));
  } finally {
    await browser.close();
    await f.close();
  }
});

test('consent.js styles work under a strict CSP with the nonce of its own script tag', { timeout: 60_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/csp-test', (route) => route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-n0nce'; style-src 'nonce-n0nce'" },
      body: '<!doctype html><html><head><script src="/assets/consent.js" nonce="n0nce"></script></head><body><main><p>Hi</p></main></body></html>',
    }));
    await page.goto(f.base + '/csp-test');
    await page.locator('.consent-banner').waitFor();
    const position = await page.evaluate(() => getComputedStyle(document.querySelector('.consent-banner')).position);
    assert.equal(position, 'fixed', 'the injected <style> was allowed');
  } finally {
    await browser.close();
    await f.close();
  }
});

test('consent.js with a skip rule that does not parse: no banner, and a visible error on a development host', { timeout: 60_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/broken-skip', (route) => route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><html><head><script>window.consentConfig = { skip: "^/account, ^/reset" };</script><script src="/assets/consent.js"></script></head><body><main><p>Hi</p></main></body></html>',
    }));
    await page.goto(f.base + '/broken-skip');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.consent-banner').count(), 0, 'nobody is asked');
    const alert = page.locator('.consent-error');
    assert.equal(await alert.count(), 1);
    assert.match(await alert.textContent(), /comma-separated list/);
  } finally {
    await browser.close();
    await f.close();
  }
});

test('negative control: IndexedDB and Cache Storage written before consent fail the storage check', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent', extra: "<script>indexedDB.open('trk-db', 1); caches.open('trk-cache');</script>" });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--banner', 'no', '--settle', '0', '--path-probe', 'no']);
    const check = r.report.results.find((x) => x.name === 'before consent: nothing stored in the browser');
    assert.equal(check?.status, 'FAIL', r.out);
    assert.match(check.detail, /idb:trk-db/);
    assert.match(check.detail, /cache:trk-cache/);
  } finally {
    await f.close();
  }
});

test('negative control: a late storage write is caught only with --settle', { timeout: 180_000 }, async () => {
  // 7 s: after verify's 5 s read of the page, before the settle wait ends.
  const f = await startFixture({ ids: 'consent', extra: "<script>setTimeout(() => localStorage.setItem('late_id', 'x'), 7000);</script>" });
  try {
    const name = 'before consent: nothing stored in the browser';
    const late = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--banner', 'no', '--settle', '8000', '--path-probe', 'no']);
    assert.equal(late.report.results.find((x) => x.name === name)?.status, 'FAIL', late.out);
    const quick = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--banner', 'no', '--settle', '0', '--path-probe', 'no']);
    assert.equal(quick.report.results.find((x) => x.name === name)?.status, 'PASS', 'without settling the late write is missed: ' + quick.out);
  } finally {
    await f.close();
  }
});

test('a 404 page with data-k404 sends one nf report: the path only, and whether the link was internal', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const bodies = [];
    context.on('request', (r) => { if (r.url().endsWith('/api/k')) bodies.push(r.postData() || ''); });
    const page = await context.newPage();
    const query = '?email=probe%40example.com&token=prb7f3c9a1e5d2b8f4a6c0e9d1b3a5f7c9e';
    // A broken link on the site itself, then the same path typed in.
    await page.goto(f.base + '/');
    await page.evaluate((q) => { location.href = '/old-page' + q; }, query);
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    await page.goto(f.base + '/old-page' + query);
    // A token-like segment: cleaned in the browser, and the collector agrees.
    await page.goto(f.base + '/invite/Pq7xK2mZ9_wR4tY-8sLnB' + query);
    await page.waitForTimeout(500);
    await page.goto('about:blank');
    await page.waitForTimeout(500);
    const nf = bodies.map((b) => JSON.parse(b)).filter((b) => b.e === 'nf');
    assert.deepEqual(nf.map((b) => [b.p, b.d.r]), [['/old-page', 'internal'], ['/old-page', 'none'], ['/invite/[id]', 'none']]);
    assert.ok(!bodies.some((b) => /probe|prb7f3|Pq7xK2/.test(b)), bodies.join(' | '));
    const day = [...f.store().daily.values()].find((d) => d.path === '*');
    assert.deepEqual(day.nf, { '/old-page': 2, '/invite/[id]': 1 });
    assert.deepEqual(day.nfin, { '/old-page': 1 });
    assert.ok(!JSON.stringify([...f.store().daily.values()]).includes('probe'));
  } finally {
    await browser.close();
    await f.close();
  }
});

test('broken things: CTA targets, indexing, robots.txt and the sitemap fail when they should', { timeout: 180_000 }, async () => {
  const f = await startFixture({ ids: 'consent', brokenSeo: true });
  try {
    const r = await verify(f.base, ['--pages', '/,/pricing', '--mode', 'consent', '--banner', 'no', '--settle', '0', '--path-probe', 'no', '--no-write',
      '--expect', 'a[data-kcta=whatsapp]@href=^https://wa\\.me/1\\d+$', '--expect', 'a[data-kcta=missing]',
      '--indexable', '/,/pricing,/privacy', '--noindex', '/thanks', '--sitemap',
      '--privacy-page', '/privacy', '--processors', 'Umami,Cloudflare=cloudflare.com']);
    assert.equal(r.code, 1, r.out);
    const by = (name) => r.report.results.find((x) => x.name === name);
    assert.equal(by('expect a[data-kcta=whatsapp]@href=^https://wa\\.me/1\\d+$')?.status, 'FAIL', r.out);
    assert.match(by('expect a[data-kcta=whatsapp]@href=^https://wa\\.me/1\\d+$').detail, /\/: href="https:\/\/wa\.me\/420123456789"/);
    assert.equal(by('expect a[data-kcta=missing]')?.status, 'FAIL', r.out);
    assert.match(by('indexable: /').detail, /X-Robots-Tag: noindex/);
    assert.equal(by('indexable: /').status, 'FAIL');
    assert.match(by('indexable: /pricing').detail, /robots\.txt: Disallow: \/pric\*/);
    assert.equal(by('indexable: /privacy')?.status, 'PASS', r.out);
    assert.equal(by('noindex: /thanks')?.status, 'FAIL', r.out);
    const sitemap = r.report.results.find((x) => x.name.startsWith('sitemap:'));
    assert.equal(sitemap?.status, 'FAIL', r.out);
    assert.match(sitemap.detail, /elsewhere\.example/);
    assert.match(sitemap.detail, /\/gone: 404/);
    const nf = r.report.results.find((x) => x.name.startsWith('404 page'));
    assert.equal(nf?.status, 'SKIP', 'no data-k404 on this 404 page: ' + r.out);
    assert.match(nf.detail, /data-k404/);
    // The privacy text names PostHog but not Umami, a processor the browser never sees.
    const pp = by('privacy page /privacy names every recipient');
    assert.equal(pp?.status, 'FAIL', r.out);
    assert.match(pp.detail, /not named: Umami \(--processors\), Cloudflare \(--processors\)\./);
  } finally {
    await f.close();
  }
});

test('"Delete my visit data": one request with the visit id only, the rows go, consent is withdrawn', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const bodies = [];
    context.on('request', (r) => { if (new URL(r.url()).pathname === '/api/k') bodies.push({ url: r.url(), body: r.postData() || '' }); });
    const page = await context.newPage();
    await page.goto(f.base + '/pricing?email=probe%40example.com');
    assert.equal(await page.locator('[data-consent-delete]').count(), 0, 'not before consent');
    await page.locator('button:has-text("Accept")').first().click();
    await page.goto(f.base + '/?email=probe%40example.com');
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(60 + i * 10, 200);
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300);
    // The API hands out no id.
    assert.deepEqual(await page.evaluate(() => Object.keys(window.__k)), ['deleteMyData', 'canDelete']);
    const vi = bodies.map((b) => { try { return JSON.parse(b.body).vi; } catch { return null; } }).filter(Boolean).pop();
    assert.ok(vi && f.store().rows.some((r) => r.visit === vi), 'rows of this visit exist');
    await page.locator('[data-consent-open]').first().click();
    const del = page.locator('[data-consent-delete]');
    assert.equal(await del.textContent(), 'Delete my visit data');
    // The same style as Decline and Accept: it never outweighs them.
    const [d, a, x] = await Promise.all(['button:has-text("Decline")', 'button:has-text("Accept")', '[data-consent-delete]'].map((s) => page.locator(s).first().evaluate((el) => { const c = getComputedStyle(el); return [c.fontSize, c.fontWeight, c.backgroundColor, c.borderStyle, el.className].join('|'); })));
    assert.equal(d, a);
    assert.equal(x, d);
    const from = bodies.length;
    await del.click();
    await page.waitForLoadState('load');
    await page.waitForTimeout(800);
    const sent = bodies.slice(from).filter((b) => b.body.includes('"del"'));
    assert.equal(sent.length, 1, JSON.stringify(bodies.slice(from)));
    assert.equal(sent[0].body, JSON.stringify({ del: vi }));
    assert.equal(new URL(sent[0].url).search, '');
    assert.ok(!f.store().rows.some((r) => r.visit === vi), 'the rows are gone');
    assert.equal(await page.evaluate(() => window.analyticsConsent.get()), 'denied');
    // deleteButton: false (or no k.js) offers no button.
    await page.evaluate(() => window.analyticsConsent.set('granted'));
    await page.route('**/no-delete', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><head><script>window.consentConfig = { deleteButton: false };</script><script src="/assets/consent.js"></script><script src="/assets/k.js" data-allow-automation="1"></script></head><body><main><p>Hi</p></main><button data-consent-open>Privacy settings</button></body></html>' }));
    await page.goto(f.base + '/no-delete');
    await page.locator('[data-consent-open]').click();
    await page.locator('.consent-banner').waitFor();
    assert.equal(await page.locator('[data-consent-delete]').count(), 0);
  } finally {
    await browser.close();
    await f.close();
  }
});

test('negative control: a deletion request that carries the URL fails verify, as a field or in its query', { timeout: 300_000 }, async () => {
  for (const leakyDelete of ['field', 'query']) {
    const f = await startFixture({ ids: 'consent', leakyDelete });
    try {
      const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--settle', '0', '--path-probe', 'no', '--rows-url', '/__store']);
      assert.equal(r.code, 1, r.out);
      const check = r.report.results.find((x) => x.name === 'delete my visit data: the request carries only the visit id');
      assert.equal(check?.status, 'FAIL', leakyDelete + '\n' + r.out);
      assert.match(check.detail, leakyDelete === 'field' ? /fields:/ : /a query in the request URL/);
    } finally {
      await f.close();
    }
  }
});

test('verify output: page text cannot issue workflow commands; scoped X-Robots-Tag and a moved sitemap do not fail', { timeout: 180_000 }, async () => {
  const f = await startFixture({ ids: 'consent', seoQuirks: true, extra: '<a data-kcta="evil" href="/x&#10;::error title=Injected::y&#13;&#10;::add-mask::secret">e</a>' });
  try {
    const r = await verify(f.base, ['--pages', '/,/pricing', '--mode', 'consent', '--banner', 'no', '--settle', '0', '--path-probe', 'no', '--no-write', '--github',
      '--expect', 'a[data-kcta=evil]@href=^/ok$', '--indexable', '/pricing', '--sitemap']);
    const lines = r.out.split('\n');
    const start = lines.findIndex((l) => /^::stop-commands::[0-9a-f]{32}$/.test(l));
    assert.ok(start >= 0, r.out);
    const token = lines[start].split('::')[2];
    const end = lines.indexOf(`::${token}::`);
    assert.ok(end > start, 'the listing is closed again');
    assert.ok(!lines.some((l) => /^\s*::(error title=Injected|add-mask)/.test(l)), 'no injected command at the start of a line:\n' + r.out);
    const evil = r.report.results.find((x) => x.name.startsWith('expect a[data-kcta=evil]'));
    assert.equal(evil?.status, 'FAIL', r.out);
    assert.equal(r.report.results.find((x) => x.name === 'indexable: /pricing')?.status, 'PASS', 'otherbot: noindex is not ours: ' + r.out);
    const sitemap = r.report.results.find((x) => x.name.startsWith('sitemap:'));
    assert.equal(sitemap?.status, 'PASS', r.out);
    assert.match(sitemap.detail, /redirects to \/sitemap-main\.xml/);
  } finally {
    await f.close();
  }
});

test('verify config: "expect": false is a config error, and --preview writes nothing', { timeout: 180_000 }, async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'sectionsight-cfg-'));
  await writeFile(path.join(dir, 'bad.json'), JSON.stringify({ expect: false }));
  const bad = await verify('http://127.0.0.1:9', ['--config', path.join(dir, 'bad.json')]);
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /"expect" takes a string/);
  const f = await startFixture({ ids: 'consent' });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--banner', 'no', '--settle', '0', '--path-probe', 'no', '--preview']);
    assert.equal(r.report.noWrite, true, r.out);
    assert.equal(f.store().daily.size, 0, 'a preview run stored nothing');
  } finally {
    await f.close();
  }
});

test('errors (data-errors="on"): verify --errors passes; the error reaches the totals scrubbed, with a sample and no ids', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', errors: true });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--settle', '0', '--path-probe', 'no', '--errors']);
    assert.equal(r.code, 0, r.out);
    for (const phase of ['before consent', 'after consent']) {
      assert.equal(r.report.results.find((x) => x.name === `errors: an err report, scrubbed, without ids (${phase})`)?.status, 'PASS', r.out);
    }
    const page = [...f.store().daily.values()].find((d) => d.path === '/');
    assert.ok(page?.err && Object.values(page.err).some((n) => n >= 2), 'counted before and after consent: ' + JSON.stringify(page));
    const samples = [...f.store().errs.values()].flatMap((d) => Object.values(d));
    assert.ok(samples.some((x) => x.f === '(inline)' && /^Error: sectionsight-check failed for <email> with <id> at <url> and <email> at <url>$/.test(x.m)), JSON.stringify(samples));
    assert.ok(samples.some((x) => /^Error: rejected for <email> <id>$/.test(x.m)), 'the unhandled rejection too: ' + JSON.stringify(samples));
    const all = JSON.stringify([...f.store().daily.values(), samples]);
    assert.ok(!/probe|prb7f3/.test(all), all);
    assert.ok(!f.store().rows.some((x) => x.e === 'err'), 'never a row');
  } finally {
    await f.close();
  }
});

test('negative control: an error message that leaks into the report unscrubbed fails verify --errors', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', errors: true, leakyErrors: true });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--banner', 'no', '--settle', '0', '--path-probe', 'no', '--errors']);
    assert.equal(r.code, 1, r.out);
    const check = r.report.results.find((x) => x.name === 'errors: an err report, scrubbed, without ids (before consent)');
    assert.equal(check?.status, 'FAIL', r.out);
    assert.match(check.detail, /carries the probe/);
  } finally {
    await f.close();
  }
});

test('vitals (data-vitals="on"): LCP and the slowest interaction are attributed to their sections; buckets only, no ids', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent', vitals: true });
  const browser = await chromium.launch();
  try {
    const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    // A refusal stored before: no banner, whose text would be the largest paint.
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
      localStorage.setItem('analytics-consent', 'denied');
    });
    const bodies = [];
    context.on('request', (r) => { if (r.url().endsWith('/api/k')) bodies.push(r.postData() || ''); });
    const page = await context.newPage();
    await page.goto(f.base + '/vitals?email=probe%40example.com');
    await page.waitForTimeout(800);
    await page.click('#slow');
    await page.waitForTimeout(800);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.click('#slow');
    await page.goto('about:blank');
    await page.waitForTimeout(500);
    const reports = bodies.map((b) => JSON.parse(b));
    const withCv = reports.filter((b) => b.d?.cv);
    assert.equal(withCv.length, 1, 'once per page view: ' + bodies.join(' | '));
    const { cv } = withCv[0].d;
    assert.equal(cv.lcps, 'hero-image', JSON.stringify(cv));
    assert.equal(cv.inps, 'slow-form', JSON.stringify(cv));
    assert.ok(cv.inp >= 4, 'a 600 ms handler is a poor INP bucket: ' + JSON.stringify(cv));
    assert.ok(Number.isInteger(cv.lcp) && Number.isInteger(cv.ttfb) && Number.isInteger(cv.cls), JSON.stringify(cv));
    assert.deepEqual(Object.keys(cv).sort(), ['cls', 'inp', 'inps', 'lcp', 'lcps', 'ttfb']);
    assert.ok(!/img|svg|button|#slow|http|probe|Calculate/i.test(JSON.stringify(cv)), 'no selector, text or URL: ' + JSON.stringify(cv));
    assert.ok(reports.every((b) => b.vi === undefined && b.v === undefined), 'no ids');
    const doc = [...f.store().daily.values()].find((d) => d.path === '/vitals');
    assert.equal(doc.cwv.desktop.inp[cv.inp], 1, JSON.stringify(doc));
    assert.equal(doc.cwv.desktop.lcp[cv.lcp], 1);
    assert.deepEqual(doc.cwvs.inp, { 'slow-form': 1 });
  } finally {
    await browser.close();
    await f.close();
  }
});

test('consent counts (data-consent-counts="on"): verify --consent-counts passes; totals only, no ids after Accept, nothing under GPC', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', consentCounts: true });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--settle', '0', '--path-probe', 'no', '--consent-counts']);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.report.results.find((x) => x.name === 'consent counts: totals only, no ids (the Accept too)')?.status, 'PASS', r.out);
    assert.equal(r.report.results.find((x) => x.name === 'Global Privacy Control: nothing is sent')?.status, 'PASS', r.out);
    const day = [...f.store().daily.values()].find((d) => d.path === '*');
    assert.ok(day.consent?.shown >= 1 && day.consent?.accept >= 1 && day.consent?.decline >= 1 && day.consent?.withdraw >= 1, JSON.stringify(day.consent));
    assert.ok(!f.store().rows.some((x) => x.e === 'consent'), 'never a row');
  } finally {
    await f.close();
  }
});

test('negative control: consent counts that carry the visit id fail verify --consent-counts', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', consentCounts: true, leakyConsent: true });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--settle', '0', '--path-probe', 'no', '--consent-counts']);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.report.results.find((x) => x.name === 'consent counts: totals only, no ids (the Accept too)')?.status, 'FAIL', r.out);
  } finally {
    await f.close();
  }
});

test('data-strip-utm: utm_* leave the address bar (other parameters, the hash and history.state stay), no extra view; a goal carries its entry\'s class', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent', stripUtm: true, campaigns: ['spring-sale'] });
  const browser = await chromium.launch();
  try {
    const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
      // A router's own state in the entry (as Next.js keeps it), set before k.js runs.
      history.replaceState({ router: 'kept' }, '');
      window.__len0 = history.length;
    });
    const bodies = [];
    context.on('request', (r) => { if (r.url().endsWith('/api/k')) bodies.push(r.postData() || ''); });
    const page = await context.newPage();
    await page.goto(f.base + '/?utm_source=chatgpt.com&keep=a%20b&utm_campaign=Spring-Sale&UTM_Medium=x&q=1#faq');
    await page.waitForFunction(() => !location.search.includes('utm'));
    assert.equal(await page.evaluate(() => location.pathname + location.search + location.hash), '/?keep=a%20b&q=1#faq');
    assert.deepEqual(await page.evaluate(() => history.state), { router: 'kept' });
    assert.equal(await page.evaluate(() => history.length - window.__len0), 0, 'replaced, not pushed');
    await page.click('[data-kgoal=signup]');
    await page.waitForTimeout(500);
    await page.goto('about:blank');
    await page.waitForTimeout(500);
    const sent = bodies.map((b) => JSON.parse(b));
    const entry = sent.find((b) => b.en === 1);
    assert.deepEqual(entry.u, { source: 'chatgpt.com', campaign: 'Spring-Sale' }, 'read before they were removed');
    const g = sent.find((b) => b.e === 'goal');
    assert.deepEqual([g.gr, g.gu], ['', 'chatgpt.com'], 'the goal resends only what the entry sent');
    const daily = [...f.store().daily.values()];
    assert.equal(daily.find((d) => d.path === '/').views, 1, 'removing the parameters is not a route');
    const visits = daily.find((d) => d.path === '*');
    assert.deepEqual(visits.goalsrc, { signup: { ai: 1 } });
    assert.deepEqual(visits.src, { chatgpt: 1 });
    assert.deepEqual(visits.campaign, { 'spring-sale': 1 });
  } finally {
    await browser.close();
    await f.close();
  }
});

test('data-kform: a submit sends the form name once per view, never a field; the totals count it next to the goals', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
    const context = await browser.newContext({ userAgent: ua });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const bodies = [];
    context.on('request', (r) => { if (r.url().endsWith('/api/k')) bodies.push(r.postData() || ''); });
    const page = await context.newPage();
    await page.goto(f.base + '/');
    await page.evaluate(() => {
      const form = document.createElement('form');
      form.setAttribute('data-kform', 'contact');
      form.innerHTML = '<input name="email" value="jane@example.com"><button>Send</button>';
      form.addEventListener('submit', (e) => e.preventDefault()); // a fetch-based form
      document.getElementById('faq').append(form);
    });
    await page.click('form[data-kform] button');
    await page.click('form[data-kform] button');
    await page.waitForTimeout(500);
    await page.goto('about:blank');
    await page.waitForTimeout(500);
    const forms = bodies.filter((b) => JSON.parse(b).e === 'form');
    assert.equal(forms.length, 1, 'once per form and view');
    assert.deepEqual(JSON.parse(forms[0]).d, { k: 'contact', s: 'faq' });
    assert.ok(!bodies.some((b) => b.includes('jane')), 'no field value in any report');
    const visits = [...f.store().daily.values()].find((d) => d.path === '*');
    assert.deepEqual(visits.form, { contact: 1 });
  } finally {
    await browser.close();
    await f.close();
  }
});

test('consent.js: mount end keeps <body> children untouched before them, takes focus; Escape closes a reopened banner; focus moves on after an answer; the banner fits a 400% zoom viewport', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 320, height: 256 } });
    await context.route((u) => new URL(u).pathname === '/', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace('<script src="/assets/consent.js"', '<script data-mount="end" src="/assets/consent.js"') });
    });
    const page = await context.newPage();
    await page.goto(f.base + '/');
    await page.waitForSelector('.consent-banner');
    assert.equal(await page.evaluate(() => document.body.lastElementChild.contains(document.querySelector('.consent-banner'))), true, 'last in <body>');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Decline', 'the banner that asks takes focus');
    const box = await page.evaluate(() => { const r = document.querySelector('.consent-banner').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    assert.ok(box.top >= 0 && box.bottom <= 256, `inside the viewport: ${JSON.stringify(box)}`);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.consent-banner').count(), 1, 'Escape is not an answer');
    await page.keyboard.press('Enter'); // Decline
    assert.equal(await page.locator('.consent-banner').count(), 0);
    assert.notEqual(await page.evaluate(() => document.activeElement === document.body), true, 'focus did not fall back to <body>');
    await page.locator('[data-consent-open]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.consent-banner');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.consent-banner').count(), 0, 'Escape closes the reopened banner');
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-consent-open')), true, 'focus goes back');
    assert.equal(await page.evaluate(() => localStorage.getItem('analytics-consent')), 'denied');
  } finally {
    await browser.close();
    await f.close();
  }
});

test('negative control: a collector that answers 500 to every report fails verify', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', collectorStatus: 500 });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--settle', '0', '--path-probe', 'no']);
    assert.equal(r.code, 1, r.out);
    const c = r.report.results.find((x) => x.name === 'the collector receives reports');
    assert.equal(c?.status, 'FAIL', r.out);
    assert.match(c.detail, /answered 500/);
  } finally {
    await f.close();
  }
});

test('negative control: a hydration error on the pages fails verify; the site\'s own console errors are only counted', { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', extra: '<script>console.error("Minified React error #418; visit https://react.dev/errors/418"); console.error("the site\'s own problem")</script>' });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--settle', '0', '--path-probe', 'no']);
    assert.equal(r.code, 1, r.out);
    const c = r.report.results.find((x) => x.name === 'no hydration error, CSP violation or error from the analytics scripts');
    assert.equal(c?.status, 'FAIL', r.out);
    assert.match(c.detail, /#418/);
    assert.doesNotMatch(c.detail, /own problem/);
  } finally {
    await f.close();
  }
});

test('negative control: consent.js injecting its <style> under style-src \'self\' fails verify; the stylesheet option passes', { timeout: 300_000 }, async () => {
  const CSP = '<meta http-equiv="Content-Security-Policy" content="style-src \'self\'">';
  const f = await startFixture({ ids: 'consent', extra: CSP });
  try {
    const r = await verify(f.base, ['--pages', '/', '--mode', 'consent', '--settle', '0', '--path-probe', 'no']);
    const c = r.report.results.find((x) => x.name === 'no hydration error, CSP violation or error from the analytics scripts');
    assert.equal(c?.status, 'FAIL', r.out);
    assert.match(c.detail, /Content Security Policy/);
  } finally {
    await f.close();
  }
  const g = await startFixture({ ids: 'consent', extra: CSP + '<script>window.consentConfig = Object.assign(window.consentConfig || {}, { stylesheet: "/assets/consent.css" });</script>' });
  try {
    const r = await verify(g.base, ['--pages', '/', '--mode', 'consent', '--settle', '0', '--path-probe', 'no']);
    const c = r.report.results.find((x) => x.name === 'no hydration error, CSP violation or error from the analytics scripts');
    assert.equal(c?.status, 'PASS', r.out);
    assert.equal(r.report.results.find((x) => x.name === 'the banner is shown')?.status, 'PASS', r.out);
  } finally {
    await g.close();
  }
});

test('assets/consent.css holds exactly the rules consent.js injects', async () => {
  const js = await readFile(new URL('../skills/sectionsight/assets/consent.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../skills/sectionsight/assets/consent.css', import.meta.url), 'utf8');
  const rules = js.match(/var CSS =([\s\S]*?);\n/)[1].match(/'([^']*)'/g).map((x) => x.slice(1, -1)).join('');
  assert.equal(css.replace(/\/\*[\s\S]*?\*\//, '').replace(/\s*\n\s*/g, ''), rules);
});
