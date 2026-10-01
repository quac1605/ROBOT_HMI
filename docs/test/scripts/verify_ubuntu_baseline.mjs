import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { projectRoot, readUbuntuEnvironment } from './ubuntu_environment.mjs';

// Fail before launching tests if the host/root is wrong.
const environment = readUbuntuEnvironment();
const root = projectRoot;
const front = path.join(root, 'frontend');
const contracts = path.join(root, 'packages/contracts');
const resolve = relative => path.join(root, relative);
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const startedMs = Date.now();
const runId = new Date(startedMs).toISOString().replaceAll(':', '-') + '-' + randomUUID();
const out = resolve('docs/chang-09-evidence/ubuntu-baseline/' + runId);
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const writeJson = (name, value) => fs.writeFileSync(path.join(out, name),
  JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

function inputSnapshot() {
  const files = [];
  function add(relative, optional = false) {
    const absolute = resolve(relative);
    if (optional && !fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    assert.ok(!stat.isSymbolicLink(), 'Unexpected baseline input symlink: ' + relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) add(relative + '/' + name);
    } else {
      assert.ok(stat.isFile(), 'Not a regular input: ' + relative);
      files.push(relative);
    }
  }
  for (const item of [
    'frontend/src', 'frontend/test', 'frontend/tooling', 'docs/test', 'docs/public/demo',
    'frontend/index.html', 'frontend/package.json', 'frontend/package-lock.json',
    'frontend/vite.config.js', 'frontend/eslint.config.js', 'frontend/playwright.config.js',
    'frontend/artifacts/stage6/quality-budgets.json',
    'docs/chang-08-independent-review-round2/probe.mjs',
    'docs/chang-08-independent-review-round2/browser-probe.mjs',
    'packages/contracts/src',
    'packages/contracts/test',
    'packages/contracts/package.json',
    'packages/contracts/package-lock.json',
    'packages/control-domain/src',
    'packages/control-domain/package.json',
    'packages/control-domain/package-lock.json',
    'backend/package.json',
    'backend/package-lock.json',
  ]) add(item);
  for (const item of ['frontend/public', '.nvmrc', '.gitignore', '.gitattributes']) add(item, true);
  return Object.fromEntries([...new Set(files)].sort().map(file => [file, hash(resolve(file))]));
}

const childEnv = { ...process.env, VITE_ROBOT_CLIENT: 'mock' };
delete childEnv.HMI_BROWSER_CHANNEL;
delete childEnv.HMI_BROWSER_EXECUTABLE_PATH;
const steps = [];

async function run(name, binary, args, cwd, timeoutMs) {
  const logPath = path.join(out, name + '.log');
  const log = fs.createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  const logDone = finished(log);
  // Register a rejection handler immediately; still await and propagate it below.
  void logDone.catch(() => {});
  const start = Date.now();
  let child;
  let interrupted = null;
  let hardTimer;
  const killGroup = signal => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = reason => {
    if (interrupted) return;
    interrupted = reason;
    killGroup('SIGTERM');
    hardTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  const onLogError = () => stop('LOG_WRITE_FAILED');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  log.on('error', onLogError);
  let timer;
  try {
    console.log('[RUN] ' + name + ' — log: ' + logPath);
    child = spawn(binary, args, {
      cwd, env: childEnv, shell: false, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const result = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    log.end();
    await logDone;
    steps.push({ name, startedAt: new Date(start).toISOString(),
      finishedAt: new Date().toISOString(), ...result, interrupted,
      log: name + '.log', sha256: hash(logPath) });
    assert.equal(interrupted, null, name + ' interrupted');
    assert.equal(result.code, 0, name + ' failed; read its log');
    console.log('[PASS] ' + name);
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    // Only the process group created by this step; never pkill/killall node.
    killGroup('SIGKILL');
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    log.off('error', onLogError);
    if (!log.writableEnded) log.end();
    await logDone;
  }
}

function freshReport(relative) {
  const filename = resolve(relative);
  const report = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const generated = Date.parse(report.generatedAt);
  assert.ok(Number.isFinite(generated) && generated >= startedMs && generated <= Date.now() + 1000,
    'Stale/future generatedAt: ' + relative);
  assert.ok(fs.statSync(filename).mtimeMs >= startedMs - 1000, 'Stale file: ' + relative);
  return report;
}

function checkProbe(report, prefix, expectedCount) {
  assert.ok(Array.isArray(report.results));
  assert.ok(report.results.length >= expectedCount, 'Missing probe cases');
  assert.equal(report.tests, report.results.length);
  assert.equal(report.failed, 0);
  assert.equal(report.passed, report.tests);
  assert.ok(report.results.every(item => item.passed === true));
  const ids = report.results.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate probe ID');
  for (let i = 1; i <= expectedCount; i++) {
    assert.ok(ids.includes(prefix + String(i).padStart(2, '0')), 'Missing required probe ID');
  }
}

let before;
let after;
let failure = null;
try {
  writeJson('environment.json', environment);
  before = inputSnapshot();
  writeJson('inputs-before.json', before);
  await run('contracts-conformance', 'npm', ['test'], contracts, 2 * 60_000);
  await run('stage8-full', 'npm', ['run', 'verify:stage8'], front, 30 * 60_000);
  await run('independent-module', process.execPath,
    ['docs/chang-08-independent-review-round2/probe.mjs'], root, 5 * 60_000);
  await run('independent-browser', process.execPath,
    ['docs/chang-08-independent-review-round2/browser-probe.mjs'], root, 10 * 60_000);

  const stage8 = freshReport('frontend/artifacts/stage8/acceptance.json');
  assert.equal(stage8.stage, 8);
  for (const key of ['passed', 'mockAccepted', 'ubuntuVerified']) assert.equal(stage8[key], true, key);
  assert.equal(stage8.hardwareReady, false);
  assert.equal(stage8.environment.platform, 'linux');
  assert.equal(stage8.missingNodeIds.length, 0);
  assert.equal(stage8.missingBrowserIds.length, 0);
  assert.ok(stage8.checks.length > 0 && stage8.checks.every(check => check.passed === true));
  const moduleProbe = freshReport('docs/chang-08-independent-review-round2/probe-results.json');
  const browserProbe = freshReport('docs/chang-08-independent-review-round2/browser-results.json');
  checkProbe(moduleProbe, 'R2-', 18);
  checkProbe(browserProbe, 'B2-', 6);
  assert.equal(browserProbe.platform, 'linux');
  assert.ok(typeof browserProbe.browser === 'string' && browserProbe.browser.length > 0);
  after = inputSnapshot();
  assert.deepEqual(after, before, 'Baseline inputs changed during run');
  assert.equal(readUbuntuEnvironment().git, environment.git, 'Git HEAD changed during run');
  writeJson('inputs-after.json', after);
  writeJson('stage8-acceptance.json', stage8);
  writeJson('independent-module.json', moduleProbe);
  writeJson('independent-browser.json', browserProbe);
} catch (error) {
  failure = String(error.message);
  console.error('[FAIL] ' + failure);
  process.exitCode = 1;
}
const evidenceHashes = Object.fromEntries(fs.readdirSync(out).sort()
  .filter(name => fs.statSync(path.join(out, name)).isFile())
  .map(name => [name, hash(path.join(out, name))]));
writeJson('run-summary.json', {
  scope: 'M1 shared contracts conformance + Ubuntu Stage8 mock baseline + independent probes; not Stage9 acceptance',
  runId, startedAt: new Date(startedMs).toISOString(), finishedAt: new Date().toISOString(),
  passed: failure === null, hardwareReady: false, environment, steps, failure, evidenceHashes,
});
console.log('Evidence directory: ' + out);
