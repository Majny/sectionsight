/**
 * The CI templates: the workflow parses, and the exact command lines it runs
 * (with the shared config file) fail a careless site and pass a good one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI = path.join(ROOT, 'skills/sectionsight/assets/ci');

/**
 * A small sanity check of a YAML file, enough for a workflow template: no
 * tabs, indentation in steps of two, block scalars consumed whole, and the
 * key/value lines it has, with their indentation, for the checks below.
 */
function yamlLines(text) {
  const out = [];
  let block = -1; // indentation of the key that opened a block scalar
  text.split('\n').forEach((line, i) => {
    assert.ok(!line.includes('\t'), `line ${i + 1}: a tab`);
    if (!line.trim() || line.trim().startsWith('#')) return;
    const indent = line.length - line.trimStart().length;
    if (block >= 0 && indent > block) return;
    block = -1;
    assert.equal(indent % 2, 0, `line ${i + 1}: odd indentation`);
    const body = line.trim().replace(/^- /, '');
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(body);
    assert.ok(m || line.trim().startsWith('- '), `line ${i + 1} is neither "key:" nor a list item: ${line}`);
    if (m && /^[|>][-+]?$/.test(m[2] ?? '')) block = indent + (line.trim().startsWith('- ') ? 2 : 0);
    if (m) out.push({ indent: indent + (line.trim().startsWith('- ') ? 2 : 0), key: m[1], value: (m[2] ?? '').replace(/\s+#.*$/, '') });
  });
  return out;
}

/** The job's `run:` line that calls verify.mjs, as the shell would split it. */
function commandOf(yaml, job, env) {
  const start = yaml.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, `job ${job}`);
  const rest = yaml.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}\S/);
  const section = end < 0 ? rest : rest.slice(0, end + 1);
  const line = section.split('\n').find((l) => l.includes('$VERIFY_SCRIPT"') && l.includes('--config'));
  assert.ok(line, `the verify step of ${job}`);
  const sub = (s) => s.replace(/\$\{?([A-Z_]+)\}?/g, (_, k) => {
    assert.ok(k in env, `the test sets $${k}`);
    return env[k];
  });
  const words = [];
  for (const m of line.replace(/^\s*run:\s*/, '').matchAll(/"([^"]*)"|(\S+)/g)) {
    if (m[1] !== undefined) words.push(sub(m[1]));
    else words.push(...sub(m[2]).split(/\s+/).filter(Boolean)); // unquoted: word-split
  }
  assert.equal(words[0], 'node');
  return words.slice(1);
}

function run(argv, { cwd, env = {} }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, argv, { cwd, env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env } });
    let out = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (out += b));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const ENV = {
  GITHUB_WORKSPACE: ROOT,
  VERIFY_SCRIPT: 'skills/sectionsight/scripts/verify.mjs',
  CONFIG_FILE: 'test/fixture/privacy-check.config.json',
};

test('privacy-check.yml: parses, read-only token, actions pinned to a major version, three jobs', async () => {
  const text = await readFile(path.join(CI, 'privacy-check.yml'), 'utf8');
  const lines = yamlLines(text);
  const top = lines.filter((l) => l.indent === 0).map((l) => l.key);
  for (const k of ['name', 'on', 'permissions', 'env', 'jobs']) assert.ok(top.includes(k), `top-level ${k}`);
  assert.match(text, /\npermissions:\n {2}contents: read\n/);
  assert.ok(!/\n {4}permissions:/.test(text), 'no job widens the permissions');
  const triggers = lines.filter((l) => l.indent === 2 && text.indexOf(`\n  ${l.key}:`) < text.indexOf('\npermissions:')).map((l) => l.key);
  for (const t of ['pull_request', 'deployment_status', 'schedule', 'workflow_dispatch']) assert.ok(triggers.includes(t), `trigger ${t}`);
  const uses = lines.filter((l) => l.key === 'uses').map((l) => l.value);
  assert.ok(uses.length >= 6);
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@v\d+$/, u);
  const jobs = lines.filter((l) => l.indent === 2 && text.indexOf(`\n  ${l.key}:`) > text.indexOf('\njobs:')).map((l) => l.key);
  assert.deepEqual(jobs, ['preview', 'local', 'production']);
  assert.match(text, /\n {2}START_COMMAND: /);
  assert.match(text, /\n {2}LOCAL_URL: /);
  assert.match(text, /path: ~\/\.cache\/ms-playwright/);
  const nightly = commandOf(text, 'production', { ...ENV, PRODUCTION_URL: 'https://x.test' });
  assert.ok(nightly.includes('--no-write') && nightly.includes('--github'), nightly.join(' '));
});

test('links.yml parses, read-only token, lychee and the other actions pinned to a major version', async () => {
  const text = await readFile(path.join(CI, 'links.yml'), 'utf8');
  const lines = yamlLines(text);
  assert.match(text, /\npermissions:\n {2}contents: read\n/);
  const uses = lines.filter((l) => l.key === 'uses').map((l) => l.value);
  assert.ok(uses.includes('lycheeverse/lychee-action@v2'));
  for (const u of uses) assert.match(u, /^[a-z-]+\/[a-z-]+@v\d+$/, u);
  assert.match(text, /\n {2}BASE_URL: /);
  assert.match(text, /--offline/);
  assert.match(text, /schedule:/);
});

test('deploy-marker.yml parses, read-only token, pinned actions, a step that cannot fail the run', async () => {
  const text = await readFile(path.join(CI, 'deploy-marker.yml'), 'utf8');
  const lines = yamlLines(text);
  assert.match(text, /\npermissions:\n {2}contents: read\n/);
  assert.ok(!/\n {4}permissions:/.test(text));
  for (const u of lines.filter((l) => l.key === 'uses').map((l) => l.value)) assert.match(u, /^actions\/[a-z-]+@v\d+$/, u);
  assert.ok(lines.some((l) => l.key === 'continue-on-error' && l.value === 'true' && l.indent === 4), 'the job itself');
  assert.ok(lines.some((l) => l.key === 'continue-on-error' && l.value === 'true' && l.indent > 4), 'and the marker step');
  // The sha reaches the script as one quoted argument, from the env (never interpolated into the shell).
  assert.match(text, /run: node "\$MARK_DEPLOY_SCRIPT" "\$DEPLOY_SHA"\n/);
  assert.ok(!/run:.*\$\{\{/.test(text), 'no ${{ }} inside a run line');
});

test('the example config is valid JSON with known keys only', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'sectionsight-ci-'));
  // An unknown key stops verify before it starts a browser (exit 2).
  const bad = path.join(cwd, 'bad.json');
  await (await import('node:fs/promises')).writeFile(bad, JSON.stringify({ pages: ['/'], pagez: ['/'] }));
  const r = await run([path.join(ROOT, ENV.VERIFY_SCRIPT), '--url', 'http://127.0.0.1:9', '--config', bad], { cwd });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /unknown key "pagez"/);
  const example = JSON.parse(await readFile(path.join(CI, 'privacy-check.config.example.json'), 'utf8'));
  assert.ok(Array.isArray(example.pages));
});

test("the workflow's nightly command line fails a careless page, with a FAIL in privacy-check.json", { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent', bad: true });
  const cwd = await mkdtemp(path.join(tmpdir(), 'sectionsight-ci-'));
  try {
    const yaml = await readFile(path.join(CI, 'privacy-check.yml'), 'utf8');
    const argv = commandOf(yaml, 'production', { ...ENV, PRODUCTION_URL: f.base });
    const r = await run(argv, { cwd });
    assert.equal(r.code, 1, r.out);
    const report = JSON.parse(await readFile(path.join(cwd, 'privacy-check.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.noWrite, true);
    assert.ok(report.results.some((x) => x.status === 'FAIL' && x.name === 'before consent: no cookies'), r.out);
    assert.match(r.out, /::error title=Privacy check::FAIL before consent: no cookies/);
    assert.equal(f.store().daily.size, 0, '--no-write: nothing reached the collector');
  } finally {
    await f.close();
  }
});

test("the workflow's pull-request command line passes a good site and writes the job summary", { timeout: 240_000 }, async () => {
  const f = await startFixture({ ids: 'consent' });
  const cwd = await mkdtemp(path.join(tmpdir(), 'sectionsight-ci-'));
  const summary = path.join(cwd, 'summary.md');
  try {
    const yaml = await readFile(path.join(CI, 'privacy-check.yml'), 'utf8');
    // The documented local setup: a production-like name resolved to the runner.
    const argv = commandOf(yaml, 'local', { ...ENV, LOCAL_URL: f.named, LOCAL_ARGS: '--resolve acme.test' });
    const r = await run(argv, { cwd, env: { GITHUB_STEP_SUMMARY: summary } });
    assert.equal(r.code, 0, r.out);
    const md = await readFile(summary, 'utf8');
    assert.match(md, /### Privacy check: passed/);
    assert.match(md, /\| Check \| Result \| Detail \|/);
    assert.match(md, /\| before consent: no cookies \| PASS \|/);
    const report = JSON.parse(await readFile(path.join(cwd, 'privacy-check.json'), 'utf8'));
    assert.equal(report.passed, true);
    // The config's broken-things checks ran and passed too.
    for (const prefix of ['404 page: an nf report', 'expect footer a@href', 'expect a[data-kcta=whatsapp]', 'indexable: /', 'indexable: /pricing', 'noindex: /thanks', 'sitemap: /sitemap.xml']) {
      assert.equal(report.results.find((x) => x.name.startsWith(prefix))?.status, 'PASS', prefix + '\n' + r.out);
    }
    assert.ok(!r.out.includes('::error'), r.out);
  } finally {
    await f.close();
  }
});

test('--fail-on-skip turns a SKIP into exit 1; --json names the results file', { timeout: 120_000 }, async () => {
  const f = await startFixture({ ids: 'never' });
  const cwd = await mkdtemp(path.join(tmpdir(), 'sectionsight-ci-'));
  try {
    // No banner and no private paths: those checks are skipped, nothing fails.
    const base = [path.join(ROOT, ENV.VERIFY_SCRIPT), '--url', f.base, '--pages', '/', '--mode', 'never', '--banner', 'no', '--settle', '0', '--path-probe', 'no', '--json', 'out.json'];
    const r = await run([...base, '--fail-on-skip'], { cwd });
    const report = JSON.parse(await readFile(path.join(cwd, 'out.json'), 'utf8'));
    assert.ok(!report.results.some((x) => x.status === 'FAIL'), r.out);
    assert.ok(report.results.some((x) => x.status === 'SKIP'), r.out);
    assert.equal(r.code, 1, r.out);
    assert.equal(report.passed, false);
  } finally {
    await f.close();
  }
});
