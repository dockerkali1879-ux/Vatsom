import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const filesToCopy = [
  'vatsom_premium_oils.html',
  'admin-portal.html',
  'paper_crumple_effect.js',
  'vatsom_logo.png'
];

for (const file of filesToCopy) {
  const src = path.join(rootDir, file);
  const dest = path.join(publicDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

// Also copy vatsom_premium_oils.html as public/index.html for root `/` route
const storefrontSrc = path.join(rootDir, 'vatsom_premium_oils.html');
if (fs.existsSync(storefrontSrc)) {
  fs.copyFileSync(storefrontSrc, path.join(publicDir, 'index.html'));
}

console.log('[sync-assets] Synced static assets to ./public');

