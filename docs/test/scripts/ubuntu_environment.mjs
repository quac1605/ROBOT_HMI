import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const projectRoot = fs.realpathSync(
  fileURLToPath(new URL('../../../', import.meta.url)),
);

function command(binary, args, required = true) {
  const result = spawnSync(binary, args, {
    cwd: projectRoot, encoding: 'utf8', shell: false,
    windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (required) {
    assert.ifError(result.error);
    assert.equal(result.status, 0, 'Command failed: ' + binary);
  }
  return result.error ? 'unavailable' : (result.stdout || '').trim();
}

export function readUbuntuEnvironment() {
  assert.equal(process.platform, 'linux', 'UBUNTU_REQUIRED: do not emulate OS in reports');
  const release = fs.readFileSync('/etc/os-release', 'utf8');
  const field = key => {
    const value = release.split(/\r?\n/).find(line => line.startsWith(key + '='))?.slice(key.length + 1);
    return value?.replace(/^["']|["']$/g, '');
  };
  assert.equal(field('ID'), 'ubuntu', 'This runbook targets Ubuntu');
  assert.equal(field('VERSION_ID'), '24.04', 'Confirm changed target OS before proceeding');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major === 22 && minor >= 21, 'Use agreed Node22 patch, at least baseline 22.21');
  assert.equal(fs.realpathSync(process.cwd()), projectRoot, 'Run from repository root');
  assert.equal(fs.realpathSync(command('git', ['rev-parse', '--show-toplevel'])), projectRoot);
  assert.ok(fs.existsSync(path.join(projectRoot, 'frontend/package-lock.json')), 'Missing frontend lock');
  const pinFile = path.join(projectRoot, '.nvmrc');
  const nodePin = fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8').trim().replace(/^v/, '') : null;
  if (nodePin) {
    assert.match(nodePin, /^\d+\.\d+\.\d+$/, 'Pin a full Node patch, not an alias');
    assert.equal(process.versions.node, nodePin, 'Node version differs from .nvmrc');
  }
  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform, distribution: field('ID'), versionId: field('VERSION_ID'),
    architecture: process.arch, kernel: os.release(), host: os.hostname(),
    virtualization: command('systemd-detect-virt', [], false) || 'unknown',
    root: projectRoot, node: process.version, npm: command('npm', ['--version']),
    git: command('git', ['rev-parse', 'HEAD']),
    branch: command('git', ['branch', '--show-current']), nodePin,
    rosJazzySetupPresent: fs.existsSync('/opt/ros/jazzy/setup.bash'),
    rosDistroInShell: process.env.ROS_DISTRO || null,
    scope: 'environment preflight only; no application or hardware acceptance',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(readUbuntuEnvironment(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
