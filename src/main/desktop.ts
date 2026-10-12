/**
 * Desktop integration: application shortcuts ("app link") and start-at-login for background
 * bots. Works when running from source (electron + app path) and when packaged.
 */
import { app, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface LaunchInfo {
  exe: string;
  args: string[];
  cwd: string;
}

export function launchInfo(): LaunchInfo {
  if (app.isPackaged) {
    const exe = process.env.APPIMAGE || process.execPath;
    return { exe, args: [], cwd: path.dirname(exe) };
  }
  return { exe: process.execPath, args: [app.getAppPath()], cwd: app.getAppPath() };
}

function quoteDesktopArg(a: string): string {
  return `"${a.replace(/(["`$\\])/g, '\\$1')}"`;
}

function desktopEntry(info: LaunchInfo, iconPng: string, extraArgs: string[] = [], autostart = false): string {
  const exec = [info.exe, ...info.args, ...extraArgs].map(quoteDesktopArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=FuFu Trading',
    'Comment=Crypto trading platform (BTC, ETH, SOL) with paper trading and backtesting',
    `Exec=${exec}`,
    `Path=${info.cwd}`,
    `Icon=${iconPng}`,
    'Terminal=false',
    'Categories=Finance;Office;',
    'StartupWMClass=FuFu Trading',
    ...(autostart ? ['X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=5'] : []),
    '',
  ].join('\n');
}

/** Create desktop + start menu shortcuts. Returns created paths. */
export function createShortcuts(resourcesDir: string): string[] {
  const info = launchInfo();
  const created: string[] = [];
  if (process.platform === 'win32') {
    const ico = path.join(resourcesDir, 'icon.ico');
    const targets = [path.join(app.getPath('desktop'), 'FuFu Trading.lnk'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'FuFu Trading.lnk')];
    for (const lnk of targets) {
      try {
        fs.mkdirSync(path.dirname(lnk), { recursive: true });
        const ok = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
          target: info.exe,
          args: info.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '),
          cwd: info.cwd,
          description: 'FuFu Trading — crypto trading platform',
          icon: fs.existsSync(ico) ? ico : info.exe,
          iconIndex: 0,
          appUserModelId: 'dev.jesko7.fufutrading',
        });
        if (ok) created.push(lnk);
      } catch {
        /* ignore individual failures */
      }
    }
  } else if (process.platform === 'linux') {
    const png = path.join(resourcesDir, 'icon.png');
    const entry = desktopEntry(info, png);
    const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const appFile = path.join(appsDir, 'fufutrading.desktop');
    fs.writeFileSync(appFile, entry, { mode: 0o755 });
    created.push(appFile);
    try {
      const deskDir = app.getPath('desktop');
      if (fs.existsSync(deskDir)) {
        const deskFile = path.join(deskDir, 'fufutrading.desktop');
        fs.writeFileSync(deskFile, entry, { mode: 0o755 });
        created.push(deskFile);
        execFile('gio', ['set', deskFile, 'metadata::trusted', 'true'], () => {});
      }
    } catch {
      /* no desktop folder */
    }
    execFile('update-desktop-database', [appsDir], () => {});
  } else if (process.platform === 'darwin') {
    // When packaged the .app bundle is the shortcut; nothing to do from source.
  }
  return created;
}

const LINUX_AUTOSTART = () => path.join(os.homedir(), '.config', 'autostart', 'fufutrading.desktop');

export function setAutostart(enabled: boolean, resourcesDir: string): void {
  const info = launchInfo();
  if (process.platform === 'linux') {
    const file = LINUX_AUTOSTART();
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, desktopEntry(info, path.join(resourcesDir, 'icon.png'), ['--background'], true), { mode: 0o644 });
    } else {
      try {
        fs.unlinkSync(file);
      } catch {
        /* not present */
      }
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, path: info.exe, args: [...info.args, '--background'], name: 'FuFu Trading' } as any);
}

export function getAutostart(): boolean {
  if (process.platform === 'linux') return fs.existsSync(LINUX_AUTOSTART());
  const info = launchInfo();
  return app.getLoginItemSettings({ path: info.exe, args: [...info.args, '--background'] }).openAtLogin;
}
