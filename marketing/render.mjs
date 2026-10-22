// Renders a video frame by frame: `node marketing/render.mjs launch-video` (or `dnie-video`).
//   --stills 3,7.5   PNGs of those seconds instead of the video
//   --fps 60         frame rate (default 60)
//   --out <path>     output file (default marketing/<video>/out/spain-assist-<video>.mp4)
// Needs ffmpeg on PATH and the Chromium that apps/desktop's playwright-core expects.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const { chromium } = createRequire(join(repo, 'apps/desktop/package.json'))('playwright-core');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stills: { type: 'string' },
    fps: { type: 'string', default: '60' },
    out: { type: 'string' },
  },
});
const video = positionals[0];
if (!video || !statSync(join(here, video, 'index.html'), { throwIfNoEntry: false })) {
  console.error('Usage: node marketing/render.mjs <launch-video|dnie-video> [--stills 3,7.5]');
  process.exit(1);
}
args.out ??= join(here, video, `out/spain-assist-${video}.mp4`);

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const server = createServer((req, res) => {
  const path = normalize(join(repo, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(repo) || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/marketing/${video}/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (e) => console.error(e));
await page.goto(url);
await page.waitForFunction(() => window.scene);
await page.evaluate(() => window.scene.ready());
const duration = await page.evaluate(() => window.scene.DURATION);

const frame = async (t) => {
  await page.evaluate((s) => window.scene.seek(s), t);
  return page.screenshot({ type: 'png' });
};

mkdirSync(dirname(args.out), { recursive: true });
if (args.stills) {
  for (const s of args.stills.split(',').map(Number)) {
    const file = join(dirname(args.out), `still-${s.toFixed(2)}.png`);
    await page.evaluate((x) => window.scene.seek(x), s);
    await page.screenshot({ path: file });
    console.log(file);
  }
} else {
  const fps = Number(args.fps);
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(fps),
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      args.out,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    const png = await frame(i / fps);
    if (!ffmpeg.stdin.write(png)) await new Promise((ok) => ffmpeg.stdin.once('drain', ok));
    if (i % fps === 0) process.stdout.write(`\r${i}/${frames}`);
  }
  ffmpeg.stdin.end();
  await new Promise((ok, fail) =>
    ffmpeg.on('close', (code) => (code ? fail(new Error(`ffmpeg ${code}`)) : ok())),
  );
  console.log(`\n${args.out}`);
}
await browser.close();
server.close();
