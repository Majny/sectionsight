import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVisits, planVisits, visitLine, visitText, isNotable } from '../skills/sectionsight/assets/visits.mjs';

const T0 = Date.parse('2026-10-05T08:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const entry = { source: 'google', utm: {}, lang: 'cs', country: 'cz', device: 'mobile' };

function visitRows(visit = 'aaaaaaaaaaaaaaaa', start = 0) {
  return [
    { at: at(start), day: '2026-10-05', visit, view: `${visit}-v1`, path: '/', e: 'view', d: { of: 3 }, entry },
    { at: at(start + 0.2), day: '2026-10-05', visit, view: `${visit}-v1`, path: '/', e: 'read', d: { s: 'pricing' } },
    { at: at(start + 1), day: '2026-10-05', visit, view: `${visit}-v1`, path: '/', e: 'time', d: { sec: 42, vis: 50, secs: [['intro', 12], ['pricing', 20], ['faq', 2]], dn: [25, 50, 75] } },
    { at: at(start + 1.1), day: '2026-10-05', visit, view: `${visit}-v2`, path: '/signup', e: 'view', d: { of: 1 } },
    { at: at(start + 1.2), day: '2026-10-05', visit, view: `${visit}-v2`, path: '/signup', e: 'goal', d: { k: 'signup' } },
    { at: at(start + 2), day: '2026-10-05', visit, view: `${visit}-v2`, path: '/signup', e: 'time', d: { sec: 70, vis: 70, secs: [], dn: [25] }, replay: '0199aa00-1111-7222-8333-944445555666' },
  ];
}

test('a visit as one Slack line: where from, pages with time, depth, top sections, goal, replay', () => {
  const [v] = toVisits(visitRows());
  const line = visitLine(v, { replayUrl: 'https://eu.posthog.com/project/1/replay/' });
  assert.equal(
    line,
    '🎯 🇨🇿 · mobile · google · / 0:42 ↓75% (pricing 0:20 · intro 0:12) → /signup 1:10 ↓25% → 🎯 signup · <https://eu.posthog.com/project/1/replay/0199aa00-1111-7222-8333-944445555666|▶ replay>',
  );
  assert.match(visitText(v), /1:52 on the site · 2 pages/);
});

test('visits split after 30 quiet minutes, but a late report of a known view joins its visit', () => {
  const rows = visitRows('bbbbbbbbbbbbbbbb', 0);
  rows.push({ at: at(120), day: '2026-10-05', visit: 'bbbbbbbbbbbbbbbb', view: 'bbbbbbbbbbbbbbbb-v2', path: '/signup', e: 'time', d: { sec: 5, vis: 600 } });
  rows.push({ at: at(121), day: '2026-10-05', visit: 'bbbbbbbbbbbbbbbb', view: 'v9', path: '/', e: 'view', d: {} });
  const visits = toVisits(rows);
  assert.equal(visits.length, 2);
  assert.equal(visits[0].active, 42 + 70 + 5);
  assert.equal(visits[1].views[0].view, 'v9');
});

test('plan: once a visit is quiet, once only, within the daily caps', () => {
  const rows = visitRows();
  // Still going: nothing yet.
  let { state, lines } = planVisits(rows, null, new Date(T0 + 10 * 60_000));
  assert.equal(lines.length, 0);
  ({ state, lines } = planVisits(rows, state, new Date(T0 + 40 * 60_000)));
  assert.equal(lines.length, 1);
  ({ lines } = planVisits(rows, state, new Date(T0 + 50 * 60_000)));
  assert.equal(lines.length, 0, 'posted once');
});

test('plan: an open last page waits longer; caps let goal visits through', () => {
  const open = visitRows('cccccccccccccccc').slice(0, 4); // last view has no time report
  let { lines } = planVisits(open, null, new Date(T0 + 40 * 60_000));
  assert.equal(lines.length, 0, 'the page may still be on screen');
  ({ lines } = planVisits(open, null, new Date(T0 + 60 * 60_000)));
  assert.equal(lines.length, 1);

  const many = [];
  for (let i = 0; i < 5; i++) many.push(...visitRows(`d${String(i).padStart(15, '0')}`, i * 0.01).filter((r) => r.e !== 'goal'));
  many.push(...visitRows('eeeeeeeeeeeeeeee', 0.5));
  const res = planVisits(many, null, new Date(T0 + 3 * 3600_000), { dayCap: 2 });
  assert.equal(res.lines.length, 3, 'two under the cap and the goal visit past it');
  assert.equal(res.state.days['2026-10-05'].skipped, 3);
});

test('not notable: a short single-page visit with nothing done', () => {
  const [v] = toVisits([
    { at: at(0), day: '2026-10-05', visit: 'ffffffffffffffff', view: 'v1', path: '/', e: 'view', d: {}, entry },
    { at: at(0.1), day: '2026-10-05', visit: 'ffffffffffffffff', view: 'v1', path: '/', e: 'time', d: { sec: 4 } },
  ]);
  assert.equal(isNotable(v), false);
});

test('everything a browser sent is escaped for Slack', () => {
  const [v] = toVisits([
    { at: at(0), day: '2026-10-05', visit: 'gggggggggggggggg', view: 'v1', path: '/<b>&', e: 'view', d: {}, entry: { ...entry, source: '<!channel>' } },
    { at: at(0.1), day: '2026-10-05', visit: 'gggggggggggggggg', view: 'v1', path: '/<b>&', e: 'time', d: { sec: 30 } },
  ]);
  const line = visitLine(v);
  assert.ok(!line.includes('<!channel>'));
  assert.ok(line.includes('&lt;!channel&gt;'));
  assert.ok(line.includes('/&lt;b&gt;&amp;'));
});

test('a visit across midnight is posted once, even when its first rows drop out of the window', () => {
  const day1 = (min) => ({ at: new Date(Date.parse('2026-10-05T21:50:00Z') + min * 60_000).toISOString(), day: '2026-10-05' });
  const day2 = (min) => ({ at: new Date(Date.parse('2026-10-05T22:05:00Z') + min * 60_000).toISOString(), day: '2026-10-06' });
  const rows = [
    { ...day1(0), visit: 'hhhhhhhhhhhhhhhh', view: 'v1', path: '/', e: 'view', d: {}, entry },
    { ...day1(1), visit: 'hhhhhhhhhhhhhhhh', view: 'v1', path: '/', e: 'time', d: { sec: 30 } },
    { ...day2(0), visit: 'hhhhhhhhhhhhhhhh', view: 'v2', path: '/pricing', e: 'view', d: {} },
    { ...day2(1), visit: 'hhhhhhhhhhhhhhhh', view: 'v2', path: '/pricing', e: 'time', d: { sec: 60, secs: [['plans', 40]] } },
  ];
  // The next night: the runner reads only the last two days.
  let { state, lines } = planVisits(rows, null, new Date('2026-10-05T23:30:00Z'));
  assert.equal(lines.length, 1);
  ({ state, lines } = planVisits(rows.filter((r) => r.day !== '2026-10-05'), state, new Date('2026-10-06T22:30:00Z')));
  assert.equal(lines.length, 0, 'the tail of a posted visit is not a new visit');
});

test('a 404 in a visit: marked, and as a broken link when it came from the site', () => {
  const rows = visitRows();
  rows.push({ at: at(2.5), day: '2026-10-05', visit: 'aaaaaaaaaaaaaaaa', view: 'aaaaaaaaaaaaaaaa-v3', path: '/old-page', e: 'nf', d: { r: 'internal' } });
  const [v] = toVisits(rows);
  assert.match(visitLine(v), /\/old-page.*🚫 404 \(broken link\)/);
});
