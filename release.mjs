import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2];
if (!version) {
  console.error('Uso: node release.mjs <version>  (p. ej. 5)');
  process.exit(1);
}

const copies = [
  ['app.js', `app.v${version}.js`],
  ['styles.css', `styles.v${version}.css`],
];
for (const [src, dst] of copies) {
  writeFileSync(join(root, dst), readFileSync(join(root, src), 'utf8'));
}

writeFileSync(
  join(root, 'app.json'),
  JSON.stringify(
    { version: Number(version), js: `app.v${version}.js`, css: `styles.v${version}.css` },
    null,
    2
  ) + '\n'
);

console.log(`RELEASE v${version} OK → app.json + assets versionados`);