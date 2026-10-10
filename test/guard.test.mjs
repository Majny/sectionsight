import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, cleanProperties, posthogConfig } from '../skills/sectionsight/assets/posthog-guard.mjs';

const site = { origin: 'https://example.com', hosts: ['example.com'], private: [/^\/account(\/|$)/], consented: () => true };

test('cleanUrl: absolute, relative and query-only links all lose personal parameters', () => {
  assert.equal(cleanUrl('https://example.com/pricing?e=jane%40example.com&utm_source=news', site.origin), 'https://example.com/pricing?utm_source=news');
  assert.equal(cleanUrl('signup?e=jane%40example.com&invite=abc', site.origin), '/signup');
  assert.equal(cleanUrl('?page=2&email=jane@example.com', site.origin), '/');
  assert.equal(cleanUrl('https://example.com/account/9f8e7d6c5b4a32100123', site.origin), 'https://example.com/account/[id]');
  assert.equal(cleanUrl('$direct', site.origin), '$direct');
});

test('exceptions: frame URLs and URLs in the message are cleaned', () => {
  const out = cleanProperties({ $exception_list: [{ value: 'failed at https://example.com/?e=jane%40example.com', stacktrace: { frames: [{ filename: 'https://example.com/?invite=abc123', abs_path: 'https://example.com/?invite=abc123' }] } }] }, site);
  const ex = out.$exception_list[0];
  assert.equal(ex.value, 'failed at https://example.com/');
  assert.equal(ex.stacktrace.frames[0].filename, 'https://example.com/');
});

test('the recorder cleans URL attributes of the recorded page', () => {
  const fn = posthogConfig(site, '/').session_recording.maskAttributeFn;
  assert.equal(fn('href', 'https://example.com/?e=jane%40example.com#faq'), 'https://example.com/#faq', 'a plain anchor stays');
  assert.equal(fn('src', 'https://cdn.example.com/a.png?token=abc'), 'https://cdn.example.com/a.png');
  assert.equal(fn('class', 'btn?x=1'), 'btn?x=1');
  assert.equal(fn('srcset', 'https://example.com/a.png?t=1 1x, https://example.com/b.png?t=2 2x'), 'https://example.com/a.png 1x, https://example.com/b.png 2x');
});

test('the recorder also cleans imagesrcset, ping, URL-like content and url() in style', () => {
  const fn = posthogConfig(site, '/').session_recording.maskAttributeFn;
  assert.equal(fn('imagesrcset', '/a.png?t=1 1x, /b.png?t=2 2x'), '/a.png 1x, /b.png 2x');
  assert.equal(fn('ping', '/p?e=jane%40example.com https://t.example/x?token=abc'), '/p https://t.example/x');
  assert.equal(fn('content', 'https://example.com/invite?token=abc'), 'https://example.com/invite');
  assert.equal(fn('content', '/reset?token=abc'), '/reset');
  assert.equal(fn('content', '0; url=/next?e=jane%40example.com'), '0; url=/next');
  assert.equal(fn('content', 'A page about pricing'), 'A page about pricing');
  assert.equal(fn('style', 'background:url("/img/a.png?token=a/b/c") no-repeat'), 'background:url("/img/a.png") no-repeat');
  assert.equal(fn('style', "background-image:url(https://cdn.example.com/x.png?sig=abc)"), 'background-image:url(https://cdn.example.com/x.png)');
  assert.equal(fn('style', 'color:red'), 'color:red');
});

test('pinned options: versioned scripts, no autocapture text, the attribute mask kept', () => {
  const cfg = posthogConfig(site, '/');
  assert.equal(cfg.strict_script_versioning, true);
  assert.equal(cfg.mask_all_text, true);
  assert.equal(cfg.session_recording.maskAllElementAttributes, undefined, 'it would silently disable maskAttributeFn');
});

test('before_send drops element text, copied text and Meta ids', async () => {
  const { makeBeforeSend } = await import('../skills/sectionsight/assets/posthog-guard.mjs');
  globalThis.location ??= new URL('https://example.com/pricing');
  const out = makeBeforeSend(site)({
    event: '$autocapture',
    properties: {
      $current_url: 'https://example.com/pricing',
      $el_text: 'Jane Doe',
      $selected_content: 'jane@example.com',
      $fbc: 'fb.1.1700000000000.AbC',
      $fbp: 'fb.1.1700000000000.123456',
      $elements_chain: 'a.btn:text="Jane Doe"attr__href="/x?e=jane%40example.com"nth-child="1"',
      $elements: [{ tag_name: 'a', $el_text: 'Jane Doe', attr__href: '/x?e=1' }],
    },
    $set: { $fbc: 'fb.1.1.x' },
  });
  for (const k of ['$el_text', '$selected_content', '$fbc', '$fbp']) assert.equal(out.properties[k], undefined, k);
  assert.equal(out.$set.$fbc, undefined);
  assert.equal(out.properties.$elements_chain, 'a.btn:attr__href="/x"nth-child="1"');
  assert.deepEqual(out.properties.$elements, [{ tag_name: 'a', attr__href: '/x' }]);
});

test('private paths: a string with flags is a case-insensitive regex', async () => {
  const { isPrivate } = await import('../skills/sectionsight/assets/posthog-guard.mjs');
  assert.equal(isPrivate('/Account/x', { private: ['/^\\/account(\\/|$)/i'] }), true);
  assert.equal(isPrivate('/Account/x', { private: [/^\/account(\/|$)/] }), false);
});

test('the PostHog proxy forwards the last X-Forwarded-For entry, or what clientIp says', async () => {
  const { createPostHogProxy, defaultClientIp } = await import('../skills/sectionsight/assets/posthog-proxy.mjs');
  const r = (h) => new Request('https://example.com/ingest/e/', { method: 'POST', headers: h, body: '{}' });
  assert.equal(defaultClientIp(r({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })), '203.0.113.7');
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => (seen.push(new Headers(init.headers).get('x-forwarded-for')), new Response(null, { status: 200 }));
  try {
    await createPostHogProxy()(r({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7', cookie: 'session=1' }));
    await createPostHogProxy({ clientIp: () => '198.51.100.9' })(r({ 'x-forwarded-for': '6.6.6.6' }));
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(seen, ['203.0.113.7', '198.51.100.9']);
});

test('autocapture chains from the real SDK keep only the allowlist (form action, data-*, a trailing backslash)', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { getElementsChainString } = require(new URL('../node_modules/@posthog/browser-common/dist/utils/autocapture-utils.js', import.meta.url).pathname);
  const { cleanElementsChain, cleanElements, makeBeforeSend } = await import('../skills/sectionsight/assets/posthog-guard.mjs');
  const els = [
    { tag_name: 'a', attr_class: ['btn'], 'attr__data-path': 'C:\\', attr__href: '/reset?token=SECRET123', attr__title: 'Jane Doe', 'attr__aria-label': 'jane@example.com', $el_text: 'Jan', nth_child: 1, nth_of_type: 1 },
    { tag_name: 'form', attr__action: '/reset?token=SECRETFORM', 'attr__data-user': 'jane@example.com', attr__id: 'signup', nth_child: 2, nth_of_type: 1 },
    { tag_name: 'img', attr__src: 'https://cdn.example.com/a.png?X-Amz-Signature=SIG', nth_child: 1, nth_of_type: 1 },
  ];
  const chain = getElementsChainString(els);
  assert.match(chain, /SECRET123/, 'the raw chain has the secrets');
  const clean = cleanElementsChain(chain, 'https://example.com');
  for (const secret of ['SECRET123', 'SECRETFORM', 'SIG', 'jane@example.com', 'Jane Doe', 'C:\\']) assert.ok(!clean.includes(secret), `${secret} in ${clean}`);
  assert.match(clean, /^a[.:].*href="\/reset".*;form:attr__id="signup"/);
  const objs = cleanElements(els, 'https://example.com');
  assert.ok(!JSON.stringify(objs).match(/SECRET|SIG|jane@|Jane Doe/), JSON.stringify(objs));
  globalThis.location ??= new URL('https://example.com/pricing');
  const out = makeBeforeSend(site)({ event: '$autocapture', properties: { $current_url: 'https://example.com/pricing', $elements_chain: chain } });
  assert.ok(!out.properties.$elements_chain.includes('SECRET'));
  assert.equal(posthogConfig(site, '/').mask_all_element_attributes, true);
});

test('the recorder cleans URLs whatever the attribute is called, and personal text in attributes', () => {
  const fn = posthogConfig(site, '/').session_recording.maskAttributeFn;
  for (const name of ['data-src', 'data-href', 'data-url', 'lowsrc', 'longdesc', 'data-anything']) assert.equal(fn(name, '/a?token=abc'), '/a', name);
  assert.equal(fn('data-srcset', '/a.png?t=1 1x, /b.png?t=2 2x'), '/a.png 1x, /b.png 2x');
  assert.equal(fn('itemid', 'https://example.com/u/550e8400-e29b-41d4-a716-446655440000'), 'https://example.com/u/[id]');
  assert.equal(fn('style', 'background:url(/a(1).png?token=abc)'), 'background:url(/a(1).png)');
  assert.equal(fn('style', 'background-image:image-set("/a.png?token=abc" 1x)'), 'background-image:image-set("/a.png" 1x)');
  assert.equal(fn('href', '#faq'), '#faq');
  assert.equal(fn('xlink:href', '/sprite.svg#icon'), '/sprite.svg#icon');
  assert.equal(fn('content', "0;URL='/next?token=abc'"), "0;URL='/next'");
  assert.equal(fn('srcset', 'data:image/png;base64,AAAA 1x, /b.png?t=2 2x'), 'data:image/png;base64,AAAA 1x, /b.png 2x');
  assert.equal(fn('src', 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(fn('onclick', "location='/x?token=abc'"), "location='/x'");
  for (const name of ['title', 'alt', 'aria-label', 'data-email']) assert.equal(fn(name, 'Jan jane@example.com'), '', name);
  assert.equal(fn('title', 'How it works'), 'How it works');
  assert.equal(fn('d', 'M10 20 L30 40 123456789'), 'M10 20 L30 40 123456789', 'SVG geometry stays');
});

test('chain: an attribute name the parser cannot read never folds into a kept value; ";" in a class keeps elements apart', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { getElementsChainString } = require(new URL('../node_modules/@posthog/browser-common/dist/utils/autocapture-utils.js', import.meta.url).pathname);
  const { cleanElementsChain } = await import('../skills/sectionsight/assets/posthog-guard.mjs');
  for (const nm of ['x;y', 'hx-on::after-request', 'x>y', 'x y']) {
    const chain = getElementsChainString([{ tag_name: 'a', attr__href: '/ok', ['attr__' + nm]: 'Jane Doe secret Q7xk2', nth_child: 1, nth_of_type: 1 }]);
    const out = cleanElementsChain(chain, 'https://example.com');
    assert.ok(!/Jan|Q7xk2/.test(out), `${nm}: ${out}`);
  }
  const chain = getElementsChainString([
    { tag_name: 'a', attr__href: '/docs?x=1', nth_child: 2, nth_of_type: 1 },
    { tag_name: 'div', attr__class: 'w-[calc(1px;2px)]', nth_child: 1, nth_of_type: 1 },
    { tag_name: 'body', nth_child: 1, nth_of_type: 1 },
  ]);
  assert.equal(cleanElementsChain(chain, 'https://example.com').split(';').filter((e) => /^[a-z]+[.:]/.test(e)).length >= 3, true);
});

test('protocol-relative URLs keep their host and lose their query', () => {
  assert.equal(cleanUrl('//cdn.other.net/a?token=abc', site.origin), '//cdn.other.net/a');
  const fn = posthogConfig(site, '/').session_recording.maskAttributeFn;
  assert.equal(fn('src', '//cdn.other.net/img/logo.png'), '//cdn.other.net/img/logo.png');
});

test('any non-structural attribute: URLs in its text cleaned, blanked when personal; structural ones untouched', () => {
  const fn = posthogConfig(site, '/').session_recording.maskAttributeFn;
  for (const [name, value] of [['x-data', "{ email: 'jane.doe@example.com' }"], ['hx-vals', '{"user":"jane.doe@example.com"}'], ['email', 'jane.doe@example.com'], ['for', 'user-777123456'], ['headers', 'row-777123456789']]) {
    assert.equal(fn(name, value), '', name);
  }
  assert.equal(fn('class', 'btn user-jane.doe@example.com md:flex'), 'btn md:flex');
  assert.equal(fn('title', 'Reset at https://example.com/reset?token=Q7xk2mPz now'), 'Reset at https://example.com/reset now');
  assert.equal(fn('srcdoc', "<a href='/reset?token=SECRETSECRET'>x</a>"), "<a href='/reset'>x</a>");
  assert.equal(fn('integrity', 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC'), 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC');
  assert.equal(fn('datetime', '2026-10-09T12:00'), '2026-10-09T12:00');
  assert.equal(fn('viewBox', '0 0 24 24'), '0 0 24 24');
  assert.equal(fn('data-testid', 'checkout-button'), 'checkout-button');
});
