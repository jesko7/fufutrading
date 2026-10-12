/**
 * Electron entry point: single instance, background mode (--background), tray, shortcuts.
 */
import { app, Menu, Tray, nativeImage, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { AppCore } from './core';
import { createShortcuts } from './desktop';
import { registerServices } from './services';

const argv = process.argv;
const background = argv.includes('--background');

if (process.env.FUFU_USER_DATA) app.setPath('userData', process.env.FUFU_USER_DATA);
app.setName('FuFu Trading');
if (process.platform === 'win32') app.setAppUserModelId('dev.jesko7.fufutrading');

let core: AppCore | null = null;
let tray: Tray | null = null;

function distDir(): string {
  return path.resolve(__dirname, '..');
}

function resourcesDir(): string {
  const candidates = [path.join(app.getAppPath(), 'resources'), path.join(process.resourcesPath || '', 'resources'), path.resolve(__dirname, '../../resources')];
  return candidates.find((p) => fs.existsSync(path.join(p, 'icon.png'))) || candidates[0];
}

function buildTray(): void {
  if (!core) return;
  const res = resourcesDir();
  const img = nativeImage.createFromPath(path.join(res, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('FuFu Trading');
  const c = core;
  const refresh = () => {
    const bots = c.activeBotCount();
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open FuFu Trading', click: () => c.windows.showMain() },
        { type: 'separator' },
        { label: bots ? `${bots} bot${bots === 1 ? '' : 's'} running` : 'No bots running', enabled: false },
        { label: 'Pause all bots', enabled: bots > 0, click: () => c.router.broadcast('bots:pauseAll', {}) },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            c.quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };
  refresh();
  setInterval(refresh, 5000).unref?.();
  tray.on('click', () => c.windows.showMain());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, args) => {
    if (args.includes('--background')) return;
    core?.windows.showMain();
  });

  app.whenReady().then(async () => {
    if (argv.includes('--create-shortcut')) {
      const created = createShortcuts(resourcesDir());
      console.log(created.length ? `Created shortcuts:\n${created.join('\n')}` : 'No shortcuts created');
      app.quit();
      return;
    }
    const userData = app.getPath('userData');
    core = new AppCore({
      userData,
      data: path.join(userData, 'marketdata'),
      logs: path.join(userData, 'logs'),
      resources: resourcesDir(),
      renderer: path.join(distDir(), 'renderer'),
      preload: path.join(distDir(), 'main', 'preload.js'),
      dist: distDir(),
    });
    try {
      await core.start();
      await registerServices(core);
    } catch (e) {
      core.log('error', `startup failed: ${(e as Error).stack || e}`);
      dialog.showErrorBox('FuFu Trading failed to start', String((e as Error).message || e));
    }
    buildTray();
    if (!background) core.windows.openMain();
    else core.log('info', 'started in background mode (bots only)');
  });

  app.on('window-all-closed', () => {
    if (core && !core.quitting && core.shouldStayInBackground()) return;
    app.quit();
  });

  app.on('activate', () => core?.windows.showMain());

  let shuttingDown = false;
  app.on('before-quit', (e) => {
    if (!core || shuttingDown) return;
    core.quitting = true;
    shuttingDown = true;
    e.preventDefault();
    const c = core;
    Promise.race([c.shutdown(), new Promise((r) => setTimeout(r, 4000))]).finally(() => {
      c.windows.closeAll();
      app.exit(0);
    });
  });

  process.on('uncaughtException', (err) => {
    core?.log('error', `uncaught: ${err.stack || err}`);
  });
  process.on('unhandledRejection', (err) => {
    core?.log('error', `unhandled rejection: ${(err as Error)?.stack || err}`);
  });
}
