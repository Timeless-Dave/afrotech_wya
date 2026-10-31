// Downloads the GRB hero (CC0) and builds webp/png sizes for the PWA.
// Usage: npm run build:assets
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

const HERO_URL =
  'https://upload.wikimedia.org/wikipedia/commons/8/83/George_R._Brown_Convention_Center_-_Houston%2C_Texas_-_DSC01321.JPG';

await mkdir('assets', { recursive: true });
const heroPath = 'assets/.hero-source.jpg';
const res = await fetch(HERO_URL);
if (!res.ok) throw new Error(`hero download failed: ${res.status}`);
await pipeline(res.body, createWriteStream(heroPath));

const hero = sharp(heroPath);
const meta = await hero.metadata();

for (const w of [640, 1280, 1920]) {
  await hero
    .clone()
    .resize({ width: w, withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toFile(`assets/hero-${w}.webp`);
}

await hero
  .clone()
  .resize(1200, 630, { fit: 'cover', position: 'centre' })
  .jpeg({ quality: 85, mozjpeg: true })
  .toFile('assets/og.jpg');

const iconSvg = await sharp('assets/icon.svg');
for (const size of [32, 180, 192, 512]) {
  const name = size === 180 ? 'assets/apple-touch-icon.png' : `assets/icon-${size}.png`;
  await iconSvg.clone().resize(size, size).png({ compressionLevel: 9 }).toFile(name);
}

await writeFile(
  'assets/hero-meta.json',
  JSON.stringify({ width: meta.width, height: meta.height, source: HERO_URL }, null, 2) + '\n'
);
console.log('assets ready: hero webp, og.jpg, icons');
