import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

let failed = false;
function check(condition, message) {
  console.log(`${condition ? '[PASS]' : '[FAIL]'} ${message}`);
  if (!condition) failed = true;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    check(false, `Không đọc được ${file}: ${error.message}`);
    return null;
  }
}

function newestMtime(files) {
  return Math.max(...files.filter(fs.existsSync).map((file) => fs.statSync(file).mtimeMs));
}

function oldestMtime(files) {
  return Math.min(...files.filter(fs.existsSync).map((file) => fs.statSync(file).mtimeMs));
}

function collectFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...collectFiles(entryPath));
    else if (entry.isFile()) output.push(entryPath);
  }
  return output;
}

function collectSpecs(suites, output = []) {
  for (const suite of suites ?? []) {
    output.push(...(suite.specs ?? []));
    collectSpecs(suite.suites, output);
  }
  return output;
}

console.log('=== STAGE 6 MACHINE-READABLE ACCEPTANCE EVIDENCE ===');
const browserResultPath = 'artifacts/stage6/browser-results.json';
const browserSpecPath = '../docs/test/browser/stage6.spec.js';
const benchmarkPath = 'artifacts/stage6/benchmark-results.json';
const budgetsPath = 'artifacts/stage6/quality-budgets.json';
const benchmarkCheckerPath = '../docs/test/scripts/check_benchmark_grid.mjs';
const productionSourceFiles = collectFiles('src');
const applicationInputs = [
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.js',
  ...productionSourceFiles,
];

const canonicalNodeTests = collectFiles('../docs/test')
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => path.resolve(file))
  .sort();
const discoveredProxies = collectFiles('test')
  .filter((file) => file.endsWith('.test.js'));
const proxiedNodeTests = discoveredProxies
  .flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(/import\s+['"]([^'"]+\.test\.js)['"]/g)]
      .map((match) => path.resolve(path.dirname(file), match[1]));
  })
  .sort();
check(
  JSON.stringify(proxiedNodeTests) === JSON.stringify(canonicalNodeTests),
  'Node auto-discovery proxy phủ đúng một lần toàn bộ canonical docs/test/**/*.test.js'
);

const nodeTestResult = spawnSync(process.execPath, ['--test'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  shell: false,
  timeout: 30_000,
  windowsHide: true,
});
const nodeTap = `${nodeTestResult.stdout ?? ''}\n${nodeTestResult.stderr ?? ''}`;
const readTapCount = (label) =>
  Number(new RegExp(`^# ${label} (\\d+)$`, 'm').exec(nodeTap)?.[1] ?? -1);
const nodeTestCount = readTapCount('tests');
const nodePassCount = readTapCount('pass');
check(nodeTestResult.status === 0, 'Lệnh nguyên văn `node --test` trả exit code 0');
check(nodeTestCount >= 97, '`node --test` auto-discover tối thiểu 97 test, không false-pass 0 test');
check(nodePassCount === nodeTestCount, 'Mọi Node test auto-discover đều passed');
for (const label of ['fail', 'cancelled', 'skipped', 'todo']) {
  check(readTapCount(label) === 0, `Node test có 0 ${label}`);
}
if (nodeTestResult.status !== 0 || nodeTestCount < 97 || nodePassCount !== nodeTestCount) {
  console.error(nodeTap.trim());
}

for (const file of [browserResultPath, browserSpecPath, benchmarkPath, budgetsPath, benchmarkCheckerPath]) {
  check(fs.existsSync(file), `Tồn tại ${file}`);
}

const browserResult = fs.existsSync(browserResultPath) ? readJson(browserResultPath) : null;
if (browserResult) {
  const specs = collectSpecs(browserResult.suites);
  const stage6Specs = specs.filter((spec) => /^Case \d+:/.test(spec.title));
  check(stage6Specs.length === 15, 'JSON reporter chứa đúng 15 Stage 6 browser cases');
  const numbers = stage6Specs.map((spec) => Number(/^Case (\d+):/.exec(spec.title)?.[1])).sort((a, b) => a - b);
  check(JSON.stringify(numbers) === JSON.stringify(Array.from({ length: 15 }, (_, index) => index + 1)), 'Có đủ Case 1..15, không trùng');
  for (const spec of stage6Specs) {
    const runs = (spec.tests ?? []).flatMap((test) => test.results ?? []);
    check(spec.ok === true, `${spec.title} có spec.ok=true`);
    check(runs.length > 0 && runs.every((run) => run.status === 'passed'), `${spec.title} thực thi và mọi run đều passed`);
    check((spec.tests ?? []).every((item) => item.expectedStatus === 'passed'), `${spec.title} không skip/xfail`);
  }
  check((browserResult.errors ?? []).length === 0, 'Playwright JSON không có global error');
  const evidenceMtime = fs.statSync(browserResultPath).mtimeMs;
  const inputsMtime = newestMtime([
    browserSpecPath,
    'playwright.config.js',
    '../docs/test/scripts/run_browser_tests.mjs',
    ...applicationInputs,
  ]);
  check(evidenceMtime >= inputsMtime, 'Browser artifact mới hơn spec/config/runner và toàn bộ application source');
}

if (fs.existsSync(benchmarkPath) && fs.existsSync(benchmarkCheckerPath) && fs.existsSync(budgetsPath)) {
  const result = spawnSync(process.execPath, [benchmarkCheckerPath, benchmarkPath, budgetsPath], {
    cwd: process.cwd(), stdio: 'inherit', shell: false, windowsHide: true,
  });
  check(result.status === 0, 'Benchmark checker v2.1 tái tính raw samples/raw UI series và đạt budgets');
  const evidenceMtime = fs.statSync(benchmarkPath).mtimeMs;
  const benchmarkInputs = [
    '../docs/test/scripts/benchmark_grid_chromium.mjs',
    benchmarkCheckerPath,
    budgetsPath,
    'index.html',
    'package.json',
    'package-lock.json',
    'src/schemas/mapGrid.js',
    'src/utils/normalizeOccupancyGrid.js',
    'src/utils/occupancyToRgba.js',
    'src/utils/occupancyRasterController.js',
    'src/utils/rasterRuntime.js',
    'src/utils/mapCoordinates.js',
    'src/utils/mapRenderModel.js',
    'src/components/map/Map2D.jsx',
  ];
  check(evidenceMtime >= newestMtime(benchmarkInputs), 'Benchmark artifact mới hơn production pipeline và checker/budgets');
}

const distAssetsPath = path.join('dist', 'assets');
check(fs.existsSync(distAssetsPath), 'Production dist/assets tồn tại');
if (fs.existsSync(distAssetsPath)) {
  const distFiles = [path.join('dist', 'index.html'), ...collectFiles(distAssetsPath)];
  const jsFiles = distFiles.filter((file) => file.endsWith('.js'));
  check(jsFiles.length > 0, 'Production build có JavaScript bundle');
  check(oldestMtime(distFiles) >= newestMtime(applicationInputs), 'Mọi production build output mới hơn application source/config');
  const leaked = jsFiles.some((file) => fs.readFileSync(file, 'utf8').includes('__STAGE6_TEST_CONTROLS__'));
  check(!leaked, 'Production bundle không chứa DEV-only Stage 6 controls');
}

const reportPath = '../docs/NGHIEM_THU_CHANG_06.md';
check(fs.existsSync(reportPath), `Biên bản tồn tại: ${reportPath}`);
if (fs.existsSync(reportPath)) {
  const report = fs.readFileSync(reportPath, 'utf8');
  check(report.includes('DEFERRED_STAGE_9_10'), 'Biên bản ghi đúng DEFERRED_STAGE_9_10');
  check(report.includes('Mock in-memory'), 'Biên bản ghi giới hạn full reload của mock');
}

if (failed) {
  console.error('\n[evidence:check] FAILED — bằng chứng thiếu, stale hoặc có false pass.');
  process.exit(1);
}
console.log('\n[evidence:check] PASS — browser và benchmark artifacts là kết quả thực thi mới, machine-readable.');
