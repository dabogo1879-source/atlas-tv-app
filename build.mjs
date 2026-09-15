import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const www = join(root, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

const files = ['index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest'];
for (const f of files) cpSync(join(root, f), join(www, f));

let html = readFileSync(join(www, 'index.html'), 'utf8');
html = html.replace(
  '<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>',
  '<script src="vendor/hls.min.js"></script>'
);
writeFileSync(join(www, 'index.html'), html);

mkdirSync(join(www, 'vendor'), { recursive: true });
const res = await fetch('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js');
writeFileSync(join(www, 'vendor', 'hls.min.js'), Buffer.from(await res.arrayBuffer()));

console.log('BUILD OK →', www);