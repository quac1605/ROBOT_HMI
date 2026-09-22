import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// This checker records executed evidence; it never substitutes fixtures or
// guessed pass counts for a real Node/Chromium run.
const root = fileURLToPath(new URL('../../../frontend/', import.meta.url));
process.chdir(root);
const checks = [];
function check(ok, name) {
  checks.push({ name, passed: Boolean(ok) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
}
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? files(name) : [name];
  });
}
function specs(suites) {
  return (suites || []).flatMap(suite => [...(suite.specs || []), ...specs(suite.suites)]);
}
const run = args => spawnSync(process.execPath, args, {
  cwd: root, encoding: 'utf8', timeout: 90_000, shell: false, windowsHide: true,
});
const node = run(['--test']);
const tap = (node.stdout || '') + (node.stderr || '');
const count = name => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(tap)?.[1] ?? -1);
check(node.status === 0 && count('tests') >= 141 && count('pass') === count('tests'),
  'Node auto-discovery: >=141 bài thực chạy và tất cả passed');
for (const name of ['fail', 'cancelled', 'skipped', 'todo']) check(count(name) === 0, `Node: 0 ${name}`);
for (let id = 1; id <= 19; id++) {
  const prefix = `I7-${String(id).padStart(2, '0')}:`;
  check(tap.includes('# Subtest: ' + prefix), 'Đã chạy kiểm thử độc lập ' + prefix);
}
check((tap.match(/^# Subtest: C7 /gm) || []).length >= 23, 'Đã chạy cả 23 bài C7 services/workflow');
if (node.status !== 0) console.error(tap);

const inputFiles = ['index.html', 'package.json', 'package-lock.json', 'vite.config.js', 'playwright.config.js',
  ...files('src'), ...files('../docs/test/browser'), '../docs/test/scripts/run_browser_tests.mjs'];
const browserFile = 'artifacts/stage6/browser-results.json';
let browser = null;
try { browser = JSON.parse(fs.readFileSync(browserFile, 'utf8')); }
catch (error) { check(false, 'Không đọc được browser evidence: ' + error.message); }
if (browser) {
  const all = specs(browser.suites);
  const stage7 = all.filter(spec => /^C7-\d+:/.test(spec.title));
  check(stage7.length === 12, 'Browser evidence chứa đủ 12 case C7');
  const ids = stage7.map(spec => Number(/^C7-(\d+):/.exec(spec.title)[1])).sort((a, b) => a - b);
  check(JSON.stringify(ids) === JSON.stringify(Array.from({ length: 12 }, (_, i) => i + 1)), 'Có đúng C7-01..12, không trùng');
  for (const spec of all) {
    const tests = spec.tests || [];
    check(spec.ok && tests.length > 0 && tests.every(item => item.expectedStatus === 'passed' &&
      item.results?.length > 0 && item.results.every(result => result.status === 'passed')),
    'Thực thi, không retry/skip/xfail: ' + spec.title);
  }
  check((browser.errors || []).length === 0, 'Không có browser global error');
  check(fs.statSync(browserFile).mtimeMs >= Math.max(...inputFiles.map(file => fs.statSync(file).mtimeMs)),
    'Browser evidence mới hơn source, package và cả hai bộ browser spec');
}

// Reuse, do not weaken, the Stage 6 raster/budget/build/proxy freshness gates.
const regression = run(['../docs/test/scripts/check_stage6_evidence.mjs']);
check(regression.status === 0, 'Toàn bộ Stage 6 evidence checker (gồm benchmark budgets và build freshness)');
if (regression.status !== 0) console.error(regression.stdout, regression.stderr);

const outputDir = 'artifacts/stage7';
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'node-results.tap'), tap);
fs.writeFileSync(path.join(outputDir, 'stage6-regression.txt'), (regression.stdout || '') + (regression.stderr || ''));
const passed = checks.every(item => item.passed);
const hashFiles = [...new Set([...inputFiles, ...files('test'), ...files('../docs/test/stage7'),
  '../docs/test/scripts/check_stage7_evidence.mjs', '../docs/test/scripts/check_stage6_evidence.mjs',
  'artifacts/stage6/benchmark-results.json', browserFile])];
const sourceHashes = Object.fromEntries(hashFiles.filter(fs.existsSync).sort().map(file => [file.replaceAll('\\', '/'),
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const report = { stage: 7, scope: 'MockRobotClient only; not real-robot safety certification',
  generatedAt: new Date().toISOString(), passed, node: { tests: count('tests'), passed: count('pass') },
  browser: browser ? { total: specs(browser.suites).length, stage7: 12 } : null,
  checks, sourceHashes };
fs.writeFileSync(path.join(outputDir, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
if (!passed) { console.error('[evidence:stage7] FAILED'); process.exit(1); }
console.log('[evidence:stage7] PASS — artifacts/stage7/acceptance.json');
