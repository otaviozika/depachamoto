import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const publicDir = path.join(root, 'public');
const heroPath = path.join(publicDir, 'login-mobile-hero.webp');
const tempPath = path.join(publicDir, 'login-mobile-hero-hq.tmp.webp');
const swPath = path.join(publicDir, 'service-worker.js');

if (!fs.existsSync(heroPath)) {
  throw new Error('login-mobile-hero.webp não foi gerado antes do enhancement.');
}

const input = sharp(heroPath, { failOn: 'error' });
const metadata = await input.metadata();
const baseWidth = Number(metadata.width || 0);
const baseHeight = Number(metadata.height || 0);

if (!baseWidth || !baseHeight) {
  throw new Error('Não foi possível identificar as dimensões do hero mobile.');
}

const scale = 3;
const width = baseWidth * scale;
const height = baseHeight * scale;

await sharp(heroPath, { failOn: 'error' })
  .resize(width, height, {
    fit: 'fill',
    kernel: sharp.kernel.lanczos3,
    withoutEnlargement: false
  })
  .sharpen({ sigma: 0.85, m1: 0.7, m2: 1.7, x1: 2, y2: 10, y3: 20 })
  .webp({
    quality: 100,
    alphaQuality: 100,
    smartSubsample: false,
    effort: 6
  })
  .toFile(tempPath);

fs.renameSync(tempPath, heroPath);

let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE = "[^"]+";/, 'const CACHE = "despachefull-v3.7.0-mobile-auth-exact-hq-v1";');
fs.writeFileSync(swPath, sw);

const finalSize = fs.statSync(heroPath).size;
console.log(`Mobile login hero HQ preparado: ${width}x${height}, ${(finalSize / 1024).toFixed(0)} KB.`);
