import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, msg: string) => void;

export interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

/** File + console logger with a small in-memory ring for the diagnostics panel. */
export function createLogger(dir: string, name = 'main'): { log: Logger; recent: LogEntry[] } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.log`);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const recent: LogEntry[] = [];
  const log: Logger = (level, msg) => {
    const t = Date.now();
    recent.push({ t, level, msg });
    if (recent.length > 500) recent.splice(0, recent.length - 500);
    const line = `${new Date(t).toISOString()} ${level.toUpperCase()} ${msg}\n`;
    try {
      stream.write(line);
    } catch {
      /* ignore */
    }
    if (process.env.FUFU_QUIET !== '1') {
      if (level === 'error') console.error(line.trim());
      else if (level === 'warn') console.warn(line.trim());
      else console.log(line.trim());
    }
  };
  return { log, recent };
}
