// Builds the publishable artifact in ./dist, matching what Activepieces
// publishes for official pieces and what the engine loads:
//
//   dist/package.json  — main: ./src/index.js, no runtime dependencies
//   dist/src/index.js  — one self-contained CommonJS bundle (framework inlined)
//   dist/README.md, dist/LICENSE
//
// keepNames is required: the engine finds the piece by scanning exports for
// an object whose constructor.name === 'Piece'.
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BUNDLE = join(DIST, 'src', 'index.js');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'src'), { recursive: true });

const result = await build({
  entryPoints: [join(ROOT, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: BUNDLE,
  minify: true,
  keepNames: true,
  treeShaking: true,
  metafile: true,
  logLevel: 'warning',
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
});

const hazards = (result.warnings ?? []).filter((w) =>
  [
    'indirect-require',
    'unsupported-require-call',
    'unsupported-dynamic-import',
    'require-resolve-not-external',
    'import-is-undefined',
  ].includes(w.id)
);
if (hazards.length > 0) {
  console.error('[bundle] safety gate failed:');
  for (const w of hazards) {
    console.error(`  - ${w.text} (${w.location?.file}:${w.location?.line})`);
  }
  process.exit(1);
}

const bundleBytes = statSync(BUNDLE).size;
if (bundleBytes > 5 * 1024 * 1024) {
  console.error(`[bundle] ${BUNDLE} is ${(bundleBytes / 1048576).toFixed(2)} MB, over the 5 MB cap`);
  process.exit(1);
}

cpSync(join(ROOT, 'README.md'), join(DIST, 'README.md'));
cpSync(join(ROOT, 'LICENSE'), join(DIST, 'LICENSE'));

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  bugs: pkg.bugs,
  keywords: pkg.keywords,
  main: './src/index.js',
  files: ['src/index.js', 'package.json', 'README.md', 'LICENSE'],
  dependencies: {},
};
writeFileSync(join(DIST, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(
  `[bundle] ${pkg.name}@${pkg.version} -> dist/src/index.js ${(bundleBytes / 1024).toFixed(0)} KB`
);
