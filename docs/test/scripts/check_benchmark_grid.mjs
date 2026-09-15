import fs from 'node:fs';
import process from 'node:process';

const resultsPath = process.argv[2] || 'artifacts/stage6/benchmark-results.json';
const budgetsPath = process.argv[3] || 'artifacts/stage6/quality-budgets.json';
let failed = false;

function check(condition, message) {
  console.log(`${condition ? '[PASS]' : '[FAIL]'} ${message}`);
  if (!condition) failed = true;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeFinite(value) {
  return finite(value) && value >= 0;
}

function close(actual, expected, tolerance = 1e-6) {
  return finite(actual) && finite(expected) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
}

function stats(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function checkStats(label, reported, recomputed) {
  for (const key of ['count', 'p50', 'p95', 'max', 'avg']) {
    check(close(reported?.[key], recomputed[key]), `${label}.${key} được suy ra từ raw samples`);
  }
}

if (!fs.existsSync(resultsPath) || !fs.existsSync(budgetsPath)) {
  console.error('[check_benchmark_grid] Thiếu benchmark-results.json hoặc quality-budgets.json');
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const budgets = JSON.parse(fs.readFileSync(budgetsPath, 'utf8'));

check(results.schemaVersion === '2.1.0', 'Artifact dùng schemaVersion 2.1.0');
check(Number.isFinite(Date.parse(results.timestamp)), 'Artifact có timestamp ISO hợp lệ');
check(results.methodology?.transportBytes?.includes('TextEncoder(JSON.stringify(full map.grid envelope))'), 'Byte được đo từ UTF-8 full envelope');
for (const modulePath of [
  '/src/schemas/mapGrid.js',
  '/src/utils/normalizeOccupancyGrid.js',
  '/src/utils/occupancyToRgba.js',
  '/src/utils/occupancyRasterController.js',
  '/src/utils/rasterRuntime.js',
  '/src/utils/mapCoordinates.js',
  '/src/utils/mapRenderModel.js',
  '/src/components/map/Map2D.jsx',
]) {
  check(results.methodology?.implementation?.includes(modulePath), `Benchmark dùng production module ${modulePath}`);
}

const global = results.globalInvariants ?? {};
check(global.maxActiveTasks <= budgets.globalInvariants.maxActiveTasks, 'Global active raster/native encode <= 1');
check(global.maxPendingQueue <= budgets.globalInvariants.maxPendingQueue, 'Global latest-pending queue <= 1');
check(global.outstandingUrlsAfterDispose === 0, 'Không còn object URL sau dispose');
check(global.errors === 0, 'Không có console/page/pipeline error');
check(global.unhandledRejections === 0, 'Không có unhandled rejection');

for (const [profileKey, budget] of Object.entries(budgets.profiles)) {
  console.log(`\n--- ${profileKey} ---`);
  const profile = results.profiles?.[profileKey];
  check(Boolean(profile), `Có kết quả ${profileKey}`);
  if (!profile) continue;
  const samples = profile.rawSamples ?? [];
  const committed = samples.filter((sample) => sample.outcome === 'committed');
  const dropped = samples.filter((sample) => sample.outcome === 'dropped');
  const totalBytes = samples.reduce((sum, sample) => sum + sample.envelopeUtf8Bytes, 0);

  check(samples.length >= budget.minSamples, `Có tối thiểu ${budget.minSamples} raw samples`);
  check(samples.every((sample, index) => sample.index === index + 1 && sample.gridRevision === index + 1), 'Index/revision liên tục, không trùng');
  check(samples.every((sample) => ['committed', 'dropped'].includes(sample.outcome)), 'Mỗi snapshot có outcome terminal');
  check(samples.every((sample) => Number.isInteger(sample.envelopeUtf8Bytes) && sample.envelopeUtf8Bytes > sample.envelopeCodeUnits), 'UTF-8 full-envelope bytes được đo thật (có non-ASCII sentinel)');
  check(samples.every((sample) => /^[0-9a-f]{64}$/.test(sample.envelopeSha256)), 'Mỗi serialized envelope có SHA-256');
  check(samples.every((sample, index) => (
    sample.envelopeHeader?.version === 1 &&
    sample.envelopeHeader?.type === 'map.grid' &&
    typeof sample.envelopeHeader?.subscriptionId === 'string' &&
    typeof sample.envelopeHeader?.streamId === 'string' &&
    sample.envelopeHeader?.streamEpoch === 1 &&
    sample.envelopeHeader?.sequence === index + 1 &&
    Number.isFinite(Date.parse(sample.envelopeHeader?.sentAt))
  )), 'Mỗi phép đo dùng đầy đủ MapGridEventEnvelope header');
  check(samples.every((sample) => nonNegativeFinite(sample.scheduleDelayMs)), 'Mọi arrival có schedule-delay timing');
  check(samples.every((sample) => nonNegativeFinite(sample.validationMs)), 'Mọi arrival chạy production validation');
  check(committed.every((sample) => [
    sample.rgbaMs,
    sample.toBlobMs,
    sample.decodeMs,
    sample.rasterMs,
    sample.endToEndMs,
  ].every(nonNegativeFinite)), 'Mọi commit có đủ RGBA/toBlob/decode/raster/e2e timing');
  check(profile.generatedCount === samples.length, 'generatedCount khớp raw samples');
  check(profile.committedCount === committed.length, 'committedCount khớp raw samples');
  check(profile.droppedCount === dropped.length, 'droppedCount khớp raw samples');
  check(profile.generatedCount === profile.committedCount + profile.droppedCount, 'Accounting generated = committed + dropped');
  check(profile.droppedCount / profile.generatedCount <= budget.maxDroppedRatio, `Tỉ lệ dropped <= ${budget.maxDroppedRatio}`);

  check(profile.totalEnvelopeUtf8Bytes === totalBytes, 'Tổng UTF-8 bytes được cộng lại từ raw samples');
  check(close(profile.averageEnvelopeUtf8Bytes, totalBytes / samples.length), 'Byte/message được tính lại từ raw samples');
  check(close(profile.envelopeBytesPerSecond, totalBytes * 1_000 / profile.durationMs), 'Byte/s được tính lại từ raw samples và duration');
  check(close(profile.achievedHz, samples.length * 1_000 / profile.durationMs), 'Achieved Hz được tính lại từ arrival duration');
  check(profile.achievedHz >= profile.targetHz * budget.minAchievedHzRatio, `Achieved Hz >= ${budget.minAchievedHzRatio * 100}% target`);

  const validation = stats(samples.map((sample) => sample.validationMs));
  const rgba = stats(committed.map((sample) => sample.rgbaMs));
  const raster = stats(committed.map((sample) => sample.rasterMs));
  const toBlob = stats(committed.map((sample) => sample.toBlobMs));
  const decode = stats(committed.map((sample) => sample.decodeMs));
  const endToEnd = stats(committed.map((sample) => sample.endToEndMs));
  const scheduleDelay = stats(samples.map((sample) => sample.scheduleDelayMs));
  const rawMeasurements = profile.rawMeasurements ?? {};
  const responsivenessValues = rawMeasurements.responsivenessDelaysMs;
  const animationFrameValues = rawMeasurements.animationFrameDeltasMs;
  const longTaskValues = rawMeasurements.longTaskDurationsMs;
  check(Array.isArray(responsivenessValues) && responsivenessValues.length > 0, 'Có raw responsiveness series');
  check(Array.isArray(animationFrameValues) && animationFrameValues.length > 0, 'Có raw rAF series');
  check(Array.isArray(longTaskValues), 'Có raw long-task series (được phép rỗng)');
  const responsivenessSeries = Array.isArray(responsivenessValues) ? responsivenessValues : [];
  const animationFrameSeries = Array.isArray(animationFrameValues) ? animationFrameValues : [];
  const longTaskSeries = Array.isArray(longTaskValues) ? longTaskValues : [];
  check(responsivenessSeries.every(nonNegativeFinite), 'Raw responsiveness chỉ chứa số hữu hạn không âm');
  check(animationFrameSeries.every(nonNegativeFinite), 'Raw rAF chỉ chứa số hữu hạn không âm');
  check(longTaskSeries.every(nonNegativeFinite), 'Raw long-task chỉ chứa số hữu hạn không âm');
  const responsiveness = stats(responsivenessSeries);
  const animationFrame = stats(animationFrameSeries);
  const longTasks = stats(longTaskSeries);
  checkStats(`${profileKey}.validation`, profile.validation, validation);
  checkStats(`${profileKey}.rgba`, profile.rgba, rgba);
  checkStats(`${profileKey}.raster`, profile.raster, raster);
  checkStats(`${profileKey}.toBlob`, profile.toBlob, toBlob);
  checkStats(`${profileKey}.decode`, profile.decode, decode);
  checkStats(`${profileKey}.endToEnd`, profile.endToEnd, endToEnd);
  checkStats(`${profileKey}.scheduleDelay`, profile.scheduleDelay, scheduleDelay);
  checkStats(`${profileKey}.responsiveness`, profile.responsiveness, responsiveness);
  checkStats(`${profileKey}.animationFrame`, profile.animationFrame, animationFrame);
  checkStats(`${profileKey}.longTasks`, profile.longTasks, longTasks);
  check(validation.count === samples.length, 'Validation timing count khớp toàn bộ arrivals');
  for (const [label, measurement] of Object.entries({ rgba, raster, toBlob, decode, endToEnd })) {
    check(measurement.count === committed.length, `${label} timing count khớp toàn bộ commits`);
  }
  check(validation.p95 <= budget.maxValidationP95Ms, `Validation p95 ${validation.p95.toFixed(2)}ms <= ${budget.maxValidationP95Ms}ms`);
  check(raster.p95 <= budget.maxRasterP95Ms, `Raster p95 ${raster.p95.toFixed(2)}ms <= ${budget.maxRasterP95Ms}ms`);
  check(toBlob.p95 <= budget.maxToBlobP95Ms, `toBlob p95 ${toBlob.p95.toFixed(2)}ms <= ${budget.maxToBlobP95Ms}ms`);
  check(decode.p95 <= budget.maxDecodeP95Ms, `Decode p95 ${decode.p95.toFixed(2)}ms <= ${budget.maxDecodeP95Ms}ms`);
  check(endToEnd.p95 <= budget.maxEndToEndP95Ms, `End-to-end p95 ${endToEnd.p95.toFixed(2)}ms <= ${budget.maxEndToEndP95Ms}ms`);
  check(scheduleDelay.p95 <= budget.maxScheduleDelayP95Ms, `Arrival schedule-delay p95 <= ${budget.maxScheduleDelayP95Ms}ms`);
  check(responsiveness.p95 <= budget.maxResponsivenessP95Ms, `Main-thread responsiveness p95 <= ${budget.maxResponsivenessP95Ms}ms`);
  check(animationFrame.p95 <= budget.maxAnimationFrameP95Ms, `rAF delta p95 <= ${budget.maxAnimationFrameP95Ms}ms`);
  check(longTasks.max <= budget.maxLongTaskMs, `Long task max <= ${budget.maxLongTaskMs}ms`);
  check(profile.heap?.supported === true, 'Chromium precise heap measurement khả dụng');
  check(finite(profile.heap?.beforeBytes) && finite(profile.heap?.afterBytes) && finite(profile.heap?.maxBytes), 'Heap before/after/max là số hữu hạn');
  check(profile.heap.maxBytes - profile.heap.beforeBytes <= budget.maxHeapPeakGrowthBytes, `Heap peak growth <= ${budget.maxHeapPeakGrowthBytes} bytes`);
  check(profile.maxActiveTasks <= budgets.globalInvariants.maxActiveTasks, 'Profile active task <= 1');
  check(profile.maxPendingQueue <= budgets.globalInvariants.maxPendingQueue, 'Profile pending queue <= 1');
  check(profile.createdUrlsCount === profile.revokedUrlsCount && profile.outstandingUrls === 0, 'Object URL accounting cân bằng');
  check(profile.errors?.length === 0, 'Profile không có lỗi');
}

if (failed) {
  console.error('\n[check_benchmark_grid] FAILED — artifact/budget không đạt.');
  process.exit(1);
}
console.log('\n[check_benchmark_grid] PASS — số tổng hợp đã được tái tính từ raw samples.');
