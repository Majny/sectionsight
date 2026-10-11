/**
 * The fixture site: static pages that use every asset of the skill, the
 * collector with an in-memory store at /api/k, and a fake PostHog at /ingest
 * that serves the real posthog-js extensions and records what it receives.
 *
 *   node test/server.mjs [port]      → http://127.0.0.1:<port>
 *   GET /__store                      the collector's totals and rows
 *   GET /__ingest                     what the fake PostHog received
 *   POST /__reset                     empties both
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollector, memoryStore, toNodeHandler } from '../skills/sectionsight/assets/collector.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(root, '../skills/sectionsight/assets');
const fixture = path.join(root, 'fixture');
const phDist = path.join(root, '../node_modules/posthog-js/dist');

// `bad`: the page also does what a careless setup does (a cookie, an id in
// storage, the full URL to PostHog before consent), so a test can show that
// verify.mjs fails such a site.
const BAD = `<script>
  document.cookie = '_ga=GA1.1.42.1700000000; path=/';
  localStorage.setItem('tracker_id', 'u-' + Math.random().toString(16).slice(2));
  fetch('/ingest/e/', { method: 'POST', body: JSON.stringify({ event: '$pageview', url: location.href }) });
  // A Blob body, which a browser automation tool cannot read by itself.
  navigator.sendBeacon('/api/k', new Blob([JSON.stringify({ p: '/', d: { href: location.href } })], { type: 'application/json' }));
</script>`;

// unsafeBeforeSend: PostHog runs without the guard's before_send. leakInDom:
// the page writes its own URL into its text, which the recorder keeps (an
// attribute would be cleaned by maskAttributeFn).
const UNSAFE = '<script>window.__unsafeBeforeSend = true;</script>';
const LEAK_IN_DOM = `<script>document.addEventListener('DOMContentLoaded', () => {
  const d = document.createElement('p'); d.textContent = 'You are on ' + location.href; document.querySelector('main').appendChild(d);
});</script>`;

// rawPaths: k.js without its token rule, so a token in the path is sent as
// it is (the collector still drops it, but verify.mjs sees the request).
// consentDefer: consent.js loaded with defer, as some sites do; by default the
// fixture follows references/consent.md (no defer). extra: HTML added to every
// page's head (negative controls for verify.mjs). brokenSeo: what verify's
// broken-things checks must catch (a noindex header on /, robots.txt blocking
// /pricing, /thanks without noindex, a sitemap with a foreign and a missing
// URL, and a 404 page without its data-k404 marker). leakyDelete 'field' or
// 'query': k.js's deletion request also carries the page URL, as a field or
// in the request's own URL (a negative control for verify's delete check).
// errors / vitals: k.js with data-errors="on" / data-vitals="on". leakyErrors:
// k.js without its message scrubbing (a negative control for verify --errors).
// consentCounts: k.js data-consent-counts="on" and the collector's
// consentCounts; leakyConsent: those reports with ids (a negative control for
// verify --consent-counts). stripUtm: data-strip-utm="on". campaigns: the
// collector's campaign allowlist.
export async function startFixture({ port = 0, ids = 'consent', host = '127.0.0.1', bad = false, visitStore = '', leakPrivate = false, unsafeBeforeSend = false, leakInDom = false, rawPaths = false, consentDefer = false, extra = '', brokenSeo = false, leakyDelete = '', seoQuirks = false, errors = false, vitals = false, leakyErrors = false, consentCounts = false, leakyConsent = false, stripUtm = false, campaigns = null, collectorStatus = 0 } = {}) {
  let store = memoryStore();
  const ingest = [];
  const collector = () =>
    // leakPrivate: the collector does not skip private paths either, so a
    // tracker that runs there is visible to verify.mjs.
    toNodeHandler(createCollector({ hosts: ['127.0.0.1', 'localhost', 'acme.test'], store, ids, secret: 'test', skip: leakPrivate ? [] : ['/^\\/account(\\/|$)/i'], timeZone: 'Europe/Berlin', consentCounts, ...(campaigns ? { campaigns } : {}) }));
  let collect = collector();
  const head = (await readFile(path.join(fixture, 'head.html'), 'utf8')).replace('<script src="/assets/consent.js"></script>', consentDefer ? '<script src="/assets/consent.js" defer></script>' : '<script src="/assets/consent.js"></script>');
  const footer = await readFile(path.join(fixture, 'footer.html'), 'utf8');
  const page = async (name) =>
    (await readFile(path.join(fixture, name), 'utf8'))
      .replace(' data-k404', brokenSeo ? '' : ' data-k404')
      .replace('<!--HEAD-->', (unsafeBeforeSend ? UNSAFE : '') + (leakInDom ? LEAK_IN_DOM : '') + (leakPrivate ? head.replace(' data-skip="/^\\/account(\\/|$)/i"', '') : head).replace('data-ids="consent"', `data-ids="${ids}"${visitStore ? ` data-visit-store="${visitStore}"` : ''}${errors ? ' data-errors="on"' : ''}${vitals ? ' data-vitals="on"' : ''}${consentCounts ? ' data-consent-counts="on"' : ''}${stripUtm ? ' data-strip-utm="on"' : ''}`) + (bad ? BAD : '') + extra)
      .replace('<!--FOOTER-->', footer);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    try {
      // collectorStatus: a collector that fails every report (a broken skip rule).
      if (url.pathname === '/api/k' && collectorStatus) { res.writeHead(collectorStatus); return res.end(); }
      if (url.pathname === '/api/k') return collect(req, res);
      if (url.pathname === '/__store') return send(200, 'application/json', JSON.stringify({ daily: [...store.daily.values()], rows: store.rows }));
      if (url.pathname === '/__ingest') return send(200, 'application/json', JSON.stringify(ingest));
      if (url.pathname === '/__reset') {
        store = memoryStore();
        collect = collector();
        ingest.length = 0;
        return send(204, 'text/plain', '');
      }
      if (url.pathname.startsWith('/assets/')) {
        const file = path.join(assets, path.basename(url.pathname));
        let js = await readFile(file, 'utf8');
        if (rawPaths && file.endsWith('k.js')) js = js.replace('function tokenLike(w) {', 'function tokenLike(w) { return false;');
        // leakyDelete: a deletion request that says more than the visit id.
        if (leakyDelete === 'field' && file.endsWith('k.js')) js = js.replace('JSON.stringify({ del: vi })', 'JSON.stringify({ del: vi, u: location.href })');
        if (leakyDelete === 'query' && file.endsWith('k.js')) js = js.replace('to = ENDPOINT;', 'to = ENDPOINT + location.search;');
        if (leakyErrors && file.endsWith('k.js')) js = js.replace('function scrubError(s) {', 'function scrubError(s) { return String(s);');
        // leakyConsent: consent counts sent with the ids the mode allows.
        if (leakyConsent && file.endsWith('k.js')) js = js.replaceAll("send('consent', { k: k }, null, true)", "send('consent', { k: k })").replaceAll("send('consent', { k: consentQ.shift() }, null, true)", "send('consent', { k: consentQ.shift() })");
        return send(200, 'text/javascript', js);
      }
      if (url.pathname === '/vendor/posthog.mjs') return send(200, 'text/javascript', await readFile(path.join(phDist, 'module.mjs')));
      if (url.pathname.startsWith('/ingest/')) {
        const sub = url.pathname.slice('/ingest'.length);
        if (sub.startsWith('/static/')) {
          const name = path.basename(sub).replace(/\?.*$/, '');
          return send(200, 'text/javascript', await readFile(path.join(phDist, name)).catch(() => ''));
        }
        if (/^\/array\/[^/]+\/config\.js$/.test(sub)) {
          // What PostHog's CDN serves: a script that leaves the config on window.
          const js = `(function(){window._POSTHOG_REMOTE_CONFIG=window._POSTHOG_REMOTE_CONFIG||{};window._POSTHOG_REMOTE_CONFIG['phc_fix']={config:${JSON.stringify(remoteConfig())},siteApps:[]}})();`;
          return send(200, 'text/javascript', js);
        }
        if (/^\/array\/[^/]+\/config$/.test(sub)) return send(200, 'application/json', JSON.stringify(remoteConfig()));
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = Buffer.concat(chunks);
        try {
          if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
        } catch {}
        ingest.push({ at: Date.now(), method: req.method, path: sub, query: url.search, body: body.toString('utf8') });
        return send(200, 'application/json', JSON.stringify({ status: 1 }));
      }
      const origin = `http://${req.headers.host}`;
      if (url.pathname === '/robots.txt') {
        return send(200, 'text/plain', ['# The fixture', 'User-agent: *', 'Disallow: /account/', 'Disallow: /*.pdf$', ...(brokenSeo ? ['Disallow: /pric*'] : []), 'Allow: /', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n'));
      }
      // seoQuirks: things verify must NOT fail: a noindex for another crawler
      // only, and a sitemap that moved within the site.
      if (seoQuirks && url.pathname === '/sitemap.xml') return send(301, 'text/plain', '', { location: '/sitemap-main.xml' });
      if (url.pathname === '/sitemap.xml' || (seoQuirks && url.pathname === '/sitemap-main.xml')) {
        const urls = ['/', '/pricing', '/privacy'].map((p) => origin + p).concat(brokenSeo ? ['https://elsewhere.example/page', origin + '/gone'] : []);
        return send(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>\n`);
      }
      if (url.pathname === '/pricing' && seoQuirks) return send(200, 'text/html; charset=utf-8', await page('pricing.html'), { 'x-robots-tag': 'otherbot: noindex, nofollow' });
      if (url.pathname === '/' && brokenSeo) return send(200, 'text/html; charset=utf-8', await page('index.html'), { 'x-robots-tag': 'noindex' });
      if (url.pathname === '/thanks') return send(200, 'text/html; charset=utf-8', await page(brokenSeo ? 'privacy.html' : 'thanks.html'));
      // A large image for the vitals page's LCP. Chrome ignores images under
      // 0.05 bits per pixel as LCP candidates, so it carries some detail.
      if (url.pathname === '/img/hero.svg') return send(200, 'image/svg+xml', HERO_SVG);
      const pages = { '/': 'index.html', '/pricing': 'pricing.html', '/privacy': 'privacy.html', '/spa': 'spa.html', '/spa/next': 'spa.html', '/vitals': 'vitals.html' };
      if (pages[url.pathname]) return send(200, 'text/html; charset=utf-8', await page(pages[url.pathname]));
      if (/^\/account\//i.test(url.pathname)) return send(200, 'text/html; charset=utf-8', await page('account.html'));
      if (url.pathname.startsWith('/files/')) return send(200, 'application/pdf', '%PDF-1.4');
      // Any other page: a 404 page that runs the tracker, as most sites' do.
      if (!/\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.startsWith('/__')) return send(404, 'text/html; charset=utf-8', await page('notfound.html'));
      send(404, 'text/plain', 'not found');
    } catch (err) {
      send(500, 'text/plain', String(err?.stack || err));
    }
  });
  await new Promise((r) => server.listen(port, host, r));
  const base = `http://${host}:${server.address().port}`;
  // The same server under a production-like name (verify.mjs --resolve acme.test).
  const named = `http://acme.test:${server.address().port}`;
  return { base, named, server, store: () => store, ingest, close: () => new Promise((r) => server.close(r)) };
}

const HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="560">${Array.from({ length: 400 }, (_, i) => `<rect x="${(i * 37) % 1000}" y="${(i * 53) % 560}" width="${20 + (i % 40)}" height="${15 + (i % 30)}" fill="#${((i * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}"/>`).join('')}</svg>`;

// What PostHog's remote config says for a project with replay and heatmaps on.
function remoteConfig() {
  return {
    token: 'phc_fix',
    supportedCompression: ['gzip', 'gzip-js'],
    hasFeatureFlags: false,
    captureDeadClicks: true,
    capturePerformance: { web_vitals: true, network_timing: false },
    autocapture_opt_out: false,
    autocaptureExceptions: true,
    elementsChainAsString: true,
    heatmaps: true,
    surveys: false,
    defaultIdentifiedOnly: true,
    siteApps: [],
    sessionRecording: { endpoint: '/s/', consoleLogRecordingEnabled: true, recorderVersion: 'v2', sampleRate: null, minimumDurationMilliseconds: null, linkedFlag: null, networkPayloadCapture: { recordHeaders: true, recordBody: true }, urlTriggers: [], urlBlocklist: [], eventTriggers: [], scriptConfig: null },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8787);
  const ids = process.argv[3] ?? 'consent';
  const f = await startFixture({ port, ids, bad: process.argv[4] === 'bad' });
  console.log(`fixture on ${f.base} (ids ${ids})`);
}
