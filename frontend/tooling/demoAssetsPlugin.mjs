// Vite build/dev helper (kept outside the ignored build/ output directory).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const demoDirectory = fileURLToPath(new URL('../../docs/public/demo/', import.meta.url));
export const demoFileNames = Object.freeze(['front.mp4', 'rear.mp4']);

function assetFile(name, directory) {
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run npm run assets:demo with FFmpeg installed.`);
  if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(directory)) {
    throw new Error('Demo videos must stay inside docs/public/demo.');
  }
  if (!fs.statSync(file).isFile()) throw new Error(`Not a video file: ${file}`);
  return file;
}

// Only the two videos are exposed, never README, manifest or the docs directory.
export function demoMiddleware(directory = demoDirectory, base = '/') {
  const prefix = `${base.replace(/\/$/, '')}/demo/`;
  return (request, response, next) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) return next();
    const name = pathname.slice(prefix.length);
    if (!demoFileNames.includes(name)) { response.writeHead(404); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    try {
      const file = assetFile(name, directory);
      const size = fs.statSync(file).size;
      let start = 0, end = size - 1;
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        } else start = -1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return;
        }
      }
      const headers = {
        'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1, 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = fs.createReadStream(file, { start, end });
      response.on('close', () => stream.destroy());
      stream.on('error', error => response.destroy(error));
      stream.pipe(response);
    } catch (error) { next(error); }
  };
}

export function demoAssetsPlugin() {
  let base = '/';
  return {
    name: 'robot-hmi-docs-demo-assets',
    configResolved(config) { base = config.base; },
    configureServer(server) {
      for (const name of demoFileNames) server.watcher.add(assetFile(name, demoDirectory));
      server.middlewares.use(demoMiddleware(demoDirectory, base));
    },
    generateBundle() {
      for (const name of demoFileNames) {
        const file = assetFile(name, demoDirectory);
        this.addWatchFile(file);
        this.emitFile({ type: 'asset', fileName: `demo/${name}`, source: fs.readFileSync(file) });
      }
    },
  };
}
