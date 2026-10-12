// Build script: bundles main process, preload, workers, MCP tool server and the renderer with esbuild.
//   node scripts/build.mjs           development build (sourcemaps)
//   node scripts/build.mjs --prod    minified
//   node scripts/build.mjs --watch   rebuild on change
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const prod = process.argv.includes('--prod');
const watch = process.argv.includes('--watch');
const outdir = path.join(root, 'dist');

function exists(p) {
  return fs.existsSync(path.join(root, p));
}

const nodeEntries = {
  'main/index': 'src/main/index.ts',
  'main/preload': 'src/main/preload.ts',
};
for (const [k, v] of Object.entries({
  'workers/scriptWorker': 'src/workers/scriptWorker.ts',
  'workers/backtestWorker': 'src/workers/backtestWorker.ts',
  'workers/pythonWorker': 'src/workers/pythonWorker.ts',
  'mcp/server': 'src/mcp/server.ts',
  'cli/fufu': 'src/cli/fufu.ts',
})) {
  if (exists(v)) nodeEntries[k] = v;
}

const define = { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') };

const nodeOptions = {
  absWorkingDir: root,
  entryPoints: nodeEntries,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: prod ? false : 'linked',
  minify: prod,
  external: ['electron', 'pyodide', 'bufferutil', 'utf-8-validate'],
  define,
  logLevel: 'warning',
};

const rendererOptions = {
  absWorkingDir: root,
  entryPoints: { 'renderer/app': 'src/renderer/main.tsx' },
  outdir,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  sourcemap: prod ? false : 'linked',
  minify: prod,
  jsx: 'automatic',
  loader: { '.svg': 'text', '.woff2': 'file', '.png': 'dataurl' },
  define,
  logLevel: 'warning',
};

function copyStatic() {
  fs.mkdirSync(path.join(outdir, 'renderer'), { recursive: true });
  fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(outdir, 'renderer/index.html'));
  const py = path.join(root, 'src/engine/python');
  if (fs.existsSync(py)) {
    const dst = path.join(outdir, 'python');
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(py)) if (f.endsWith('.py')) fs.copyFileSync(path.join(py, f), path.join(dst, f));
  }
  const docs = path.join(root, 'docs');
  if (fs.existsSync(docs)) {
    const dst = path.join(outdir, 'docs');
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(docs)) if (f.endsWith('.md')) fs.copyFileSync(path.join(docs, f), path.join(dst, f));
  }
}

const t0 = Date.now();
if (watch) {
  const ctxs = await Promise.all([esbuild.context(nodeOptions), esbuild.context(rendererOptions)]);
  copyStatic();
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching for changes…');
} else {
  await Promise.all([esbuild.build(nodeOptions), esbuild.build(rendererOptions)]);
  copyStatic();
  console.log(`built in ${Date.now() - t0}ms${prod ? ' (prod)' : ''}`);
}
