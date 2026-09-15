import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const cwd = process.cwd();
const playwrightCli = path.resolve(cwd, 'node_modules', '@playwright', 'test', 'cli.js');
const viteCli = path.resolve(cwd, 'node_modules', 'vite', 'bin', 'vite.js');
const url = 'http://127.0.0.1:4173';
const env = {
  ...process.env,
  NODE_PATH: process.env.NODE_PATH
    ? `${path.resolve(cwd, 'node_modules')}${path.delimiter}${process.env.NODE_PATH}`
    : path.resolve(cwd, 'node_modules'),
  STAGE6_EXTERNAL_SERVER: 'true',
  VITE_ENABLE_STAGE6_TEST_CONTROLS: 'true',
};

function waitForHttp(timeoutMs = 20_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 500) resolve();
        else setTimeout(probe, 100);
      });
      request.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) reject(new Error(`Vite không sẵn sàng tại ${url}`));
        else setTimeout(probe, 100);
      });
      request.setTimeout(1_000, () => request.destroy());
    };
    probe();
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
  cwd,
  env,
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
});

let exitCode = 1;
try {
  await waitForHttp();
  const playwright = spawn(process.execPath, [playwrightCli, 'test', '--project=chromium', ...process.argv.slice(2)], {
    cwd,
    env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  exitCode = await waitForExit(playwright);
} catch (error) {
  console.error('[test:browser] Không thể chạy Chromium acceptance:', error);
} finally {
  vite.kill();
  await Promise.race([waitForExit(vite), new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

process.exit(exitCode);
