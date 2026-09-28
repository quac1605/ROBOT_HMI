import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Full Stage 8 gate, not just acceptance of the five Step F sample tests.
const root = fileURLToPath(new URL('../../../frontend/', import.meta.url));
const output = path.join(root, 'artifacts/stage8');
const checks = [];
const check = (passed, name) => {
  checks.push({ name, passed: Boolean(passed) });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
};
const resolve = name => path.resolve(root, name);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
}) : [];
const inputs = () => [...new Set([
  ...['index.html', 'package.json', 'package-lock.json', 'vite.config.js', 'eslint.config.js', 'playwright.config.js'].map(resolve),
  ...['src', 'public', 'tooling', 'test', '../docs/test', '../docs/public/demo'].flatMap(name => files(resolve(name))),
])].sort();
const snapshot = () => Object.fromEntries(inputs().map(file => [path.relative(root, file).replaceAll('\\', '/'), hash(file)]));
const before = snapshot();
const run = args => spawnSync(process.execPath, args, {
  cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
});
const node = run(['--test']);
const tap = `${node.stdout || ''}\n${node.stderr || ''}`;
const count = name => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(tap)?.[1] ?? -1);
check(node.status === 0 && count('tests') >= 146 && count('pass') === count('tests'), 'Node: baseline + F2, tất cả thực chạy và pass');
for (const name of ['fail', 'cancelled', 'skipped', 'todo']) check(count(name) === 0, `Node: 0 ${name}`);
const ids = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${String(from + index).padStart(2, '0')}`);
const requiredNodeIds = [...ids('N8-', 1, 26), ...ids('U8-', 1, 6), ...ids('T8-', 1, 8), ...ids('F8-N', 1, 3), ...ids('N8-H', 1, 17)];
const missingNodeIds = [];
for (const id of requiredNodeIds) {
  const found = (tap.match(new RegExp(`^# Subtest: ${id}:`, 'gm')) || []).length;
  check(found === 1, `Node manifest: ${id} chạy đúng một lần`);
  if (found !== 1) missingNodeIds.push(id);
}
if (node.status !== 0) console.error(tap);

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(resolve(name), 'utf8')); }
  catch (error) { check(false, `Không đọc được ${name}: ${error.message}`); return null; }
}
const specs = suites => (suites || []).flatMap(suite => [...(suite.specs || []), ...specs(suite.suites)]);
const browserPath = 'artifacts/stage6/browser-results.json';
const browser = readJson(browserPath);
const browserSpecs = specs(browser?.suites);
const requiredBrowserIds = [...ids('C8-', 1, 16), ...ids('U8-', 7, 8), ...ids('F8-A', 1, 3), 'C8-H-route', 'C8-H-logout'];
const missingBrowserIds = [];
for (const id of requiredBrowserIds) {
  const matches = browserSpecs.filter(spec => spec.title.startsWith(`${id}:`));
  const passed = matches.length === 1 && matches.every(spec => spec.ok && spec.tests?.length === 1 &&
    spec.tests.every(item => item.expectedStatus === 'passed' && item.results?.length === 1 &&
      item.results[0].status === 'passed' && item.results[0].retry === 0));
  check(passed, `Browser manifest: ${id}, pass ngay lần đầu, không skip/retry/xfail`);
  if (!passed) missingBrowserIds.push(id);
}
check(Boolean(browser) && (browser.errors || []).length === 0, 'Browser không có global error');
const browserInputs = inputs().filter(file => !file.includes(`${path.sep}test${path.sep}stage8${path.sep}`));
if (browser) check(fs.statSync(resolve(browserPath)).mtimeMs >= Math.max(...browserInputs.map(file => fs.statSync(file).mtimeMs)),
  'Browser report mới hơn app/config/spec/assets và scripts');

const manifest = readJson('../docs/public/demo/manifest.json');
check(manifest?.assets?.length === 2 && manifest.assets[0].name === 'front.mp4' && manifest.assets[1].name === 'rear.mp4',
  'Manifest chứa đúng front/rear');
for (const name of ['front.mp4', 'rear.mp4']) {
  const source = resolve(`../docs/public/demo/${name}`), built = resolve(`dist/demo/${name}`);
  const record = manifest?.assets?.find(asset => asset.name === name);
  check(Boolean(record) && fs.existsSync(source) && hash(source) === record.sha256, `SHA-256 nguồn ${name} khớp manifest`);
  check(fs.existsSync(source) && fs.existsSync(built) && hash(source) === hash(built), `Build copy ${name} khớp nguồn docs`);
}
const builtJs = files(resolve('dist/assets')).filter(file => file.endsWith('.js'));
check(builtJs.length > 0 && !builtJs.some(file => fs.readFileSync(file, 'utf8').includes('__STAGE8_TEST_CONTROLS__')),
  'Production build không chứa Stage 8 DEV hooks');

// Preserve all Stage 6/7 regressions, benchmark budgets and proxy discovery checks.
const regression = run(['../docs/test/scripts/check_stage7_evidence.mjs']);
check(regression.status === 0, 'Stage 7 checker gồm toàn bộ Stage 6/benchmark/build/proxy gates');
if (regression.status !== 0) console.error(regression.stdout || '', regression.stderr || '');
const after = snapshot();
check(JSON.stringify(before) === JSON.stringify(after), 'Input hashes không thay đổi trong khi thu evidence');
const ubuntuVerified = process.platform === 'linux' && fs.existsSync('/etc/os-release') &&
  /^ID=ubuntu$/m.test(fs.readFileSync('/etc/os-release', 'utf8'));
check(ubuntuVerified, 'Đợt nghiệm thu đích được chạy trên Ubuntu (Windows không thay thế)');
const passed = checks.every(item => item.passed);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'node-results.tap'), tap);
fs.writeFileSync(path.join(output, 'stage7-regression.txt'), `${regression.stdout || ''}\n${regression.stderr || ''}`);
const evidenceFiles = [browserPath, 'artifacts/stage7/acceptance.json', 'artifacts/stage6/benchmark-results.json'];
const evidenceHashes = Object.fromEntries(evidenceFiles.filter(name => fs.existsSync(resolve(name))).map(name => [name, hash(resolve(name))]));
const report = { stage: 8, scope: 'Full planned mock acceptance; Step F/G alone is insufficient; no real robot',
  generatedAt: new Date().toISOString(), passed, mockAccepted: checks.filter(item => !item.name.startsWith('Đợt nghiệm thu đích')).every(item => item.passed),
  ubuntuVerified: Boolean(ubuntuVerified && passed), hardwareReady: false,
  environment: { platform: process.platform, release: os.release(), architecture: process.arch, node: process.version },
  node: { tests: count('tests'), passed: count('pass') }, missingNodeIds, missingBrowserIds,
  checks, sourceHashes: after, evidenceHashes };
fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
if (!passed) {
  console.error('[evidence:stage8] FAILED — see artifacts/stage8/acceptance.json; never substitute sample tests for complete acceptance.');
  process.exitCode = 1;
} else console.log('[evidence:stage8] PASS');
