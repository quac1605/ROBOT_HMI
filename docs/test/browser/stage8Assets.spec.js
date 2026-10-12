import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('F8-A01: docs MP4 bytes, ranges and existing public assets are served correctly', async ({ request }) => {
  for (const name of ['front.mp4', 'rear.mp4']) {
    const response = await request.get(`/demo/${name}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('video/mp4');
    const actual = await response.body();
    const expected = fs.readFileSync(path.resolve(test.info().config.rootDir, '../../public/demo', name));
    expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
    const partial = await request.get(`/demo/${name}`, { headers: { Range: 'bytes=0-63' } });
    expect(partial.status()).toBe(206);
    expect((await partial.body()).length).toBe(64);
  }
  expect((await request.get('/demo/README.md')).status()).toBe(404);
  const favicon = await request.get('/favicon.svg');
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()['content-type']).toContain('image/svg+xml');
});

async function mapping(page) {
  await page.goto('/login');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await page.waitForURL('**/status');
  await page.goto('/mapping');
}

test('F8-A02: MappingPage decodes front/rear at 640x360 and video loops', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await mapping(page);
  const joystick = await page.getByTestId('mapping-joystick').elementHandle();
  await expect(page.getByTestId('mapping-joystick')).toHaveAttribute('aria-disabled', 'true');
  for (const id of ['front', 'rear']) {
    await page.getByTestId(`camera-select-${id}`).click();
    const video = page.getByTestId(`camera-video-${id}`);
    await expect.poll(() => video.evaluate(element => ({ width: element.videoWidth, height: element.videoHeight })))
      .toEqual({ width: 640, height: 360 });
    await expect(page.getByTestId('camera-health')).toContainText('Live');
    const info = await video.evaluate(async element => {
      const frame = () => new Promise(resolve => element.requestVideoFrameCallback((_, metadata) => resolve(metadata.presentedFrames)));
      const first = await frame();
      const next = await frame();
      return { duration: element.duration, loop: element.loop, advancing: next > first, src: element.currentSrc };
    });
    expect(info.duration).toBeCloseTo(12, 1);
    expect(info.loop).toBe(true);
    expect(info.advancing).toBe(true);
    expect(new URL(info.src).pathname).toBe(`/demo/${id}.mp4`);
    await video.evaluate(element => { element.currentTime = 11.7; });
    await expect.poll(() => video.evaluate(element => element.currentTime)).toBeLessThan(2);
  }
  expect(await joystick.evaluate(element => element.isConnected)).toBe(true);
  expect(errors).toEqual([]);
});

test('F8-A03: front and rear rendered frames have the expected horizontal flip', async ({ page }) => {
  await page.goto('/login');
  const result = await page.evaluate(async () => {
    async function sample(url) {
      const video = document.createElement('video');
      video.muted = true;
      document.body.append(video);
      try {
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error('Video decode failed'));
          video.src = url;
        });
        await new Promise(resolve => { video.onseeked = resolve; video.currentTime = 1; });
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0);
        return context.getImageData(0, 0, 640, 360).data;
      } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); }
    }
    const front = await sample('/demo/front.mp4');
    const rear = await sample('/demo/rear.mp4');
    let mirrored = 0, unflipped = 0, count = 0;
    for (let y = 10; y < 350; y += 11) for (let x = 10; x < 630; x += 13) {
      for (let channel = 0; channel < 3; channel++) {
        const index = (y * 640 + x) * 4 + channel;
        const mirror = (y * 640 + (639 - x)) * 4 + channel;
        mirrored += Math.abs(front[index] - rear[mirror]);
        unflipped += Math.abs(front[index] - rear[index]);
        count++;
      }
    }
    return { mirrored: mirrored / count, unflipped: unflipped / count };
  });
  expect(result.mirrored).toBeLessThan(15); // Lossy H.264: not bit-identical pixels.
  expect(result.unflipped).toBeGreaterThan(result.mirrored * 3);
});
