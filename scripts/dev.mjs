// Development mode: rebuilds on every change (esbuild watch) and restarts the app when
// main-process, preload or worker code changes. Renderer changes need only Ctrl+R in the window.
//   npm run dev
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let app = null;
let restarting = false;

function startApp() {
  app = spawn(require('electron'), [root], { stdio: 'inherit', env });
  app.on('exit', (code) => {
    if (restarting) return;
    console.log(`app exited (${code ?? 0}); stopping dev mode`);
    build.kill();
    process.exit(code ?? 0);
  });
}

function restart() {
  if (!app) return startApp();
  restarting = true;
  app.once('exit', () => {
    restarting = false;
    startApp();
  });
  app.kill();
}

let timer = null;
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log('main-process code changed — restarting the app');
    restart();
  }, 400);
};

const build = spawn(process.execPath, [path.join(root, 'scripts/build.mjs'), '--watch'], { stdio: ['ignore', 'pipe', 'inherit'] });
build.stdout.setEncoding('utf8');
let started = false;
build.stdout.on('data', (d) => {
  process.stdout.write(d);
  if (!started && /watching for changes/.test(d)) {
    started = true;
    startApp();
    for (const dir of ['main', 'workers']) {
      const p = path.join(root, 'dist', dir);
      if (fs.existsSync(p)) fs.watch(p, (_e, f) => f && f.endsWith('.js') && schedule());
    }
  }
});
build.on('exit', (code) => {
  if (code) {
    console.error(`build watcher exited with ${code}`);
    app?.kill();
    process.exit(code);
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restarting = true;
    app?.kill();
    build.kill();
    process.exit(0);
  });
}
