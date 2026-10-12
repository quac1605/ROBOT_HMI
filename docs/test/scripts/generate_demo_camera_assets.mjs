import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../../public/demo/', import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const version = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true, shell: false });
if (version.error || version.status !== 0) {
  throw new Error('FFmpeg unavailable. Install FFmpeg or set FFMPEG_PATH to its executable.');
}
fs.mkdirSync(directory, { recursive: true });
const names = ['front.mp4', 'rear.mp4'];
for (const name of [...names, 'manifest.json']) {
  if (fs.existsSync(path.join(directory, name))) throw new Error(`${name} already exists; keep or back up existing assets before regenerating.`);
}
const temporary = fs.mkdtempSync(path.join(directory, '.generate-'));
const records = [];
try {
  for (const name of names) {
    const args = ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15'];
    if (name === 'rear.mp4') args.push('-vf', 'hflip');
    args.push('-t', '12', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(temporary, name));
    const run = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120_000 });
    if (run.error || run.status !== 0) throw new Error(run.error?.message || run.stderr);
    const bytes = fs.readFileSync(path.join(temporary, name));
    records.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      width: 640, height: 360, fps: 15, durationSeconds: 12, codec: 'h264', pixelFormat: 'yuv420p',
      filter: name === 'rear.mp4' ? 'hflip' : null });
  }
  for (const name of names) fs.renameSync(path.join(temporary, name), path.join(directory, name));
  const manifest = { source: 'FFmpeg lavfi testsrc2, synthetic, no real camera',
    generatedAt: new Date().toISOString(), ffmpegVersion: version.stdout.split(/\r?\n/)[0], assets: records };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  // This is only the exact temporary directory created above, never docs itself.
  const checked = path.resolve(temporary);
  if (path.dirname(checked) !== path.resolve(directory) || !path.basename(checked).startsWith('.generate-')) {
    throw new Error('Refuse cleanup outside the generated temporary directory');
  }
  fs.rmSync(checked, { recursive: true, force: true });
}
