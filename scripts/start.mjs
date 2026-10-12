// Launch the app with a clean environment. Some hosts (e.g. editor extension processes) export
// ELECTRON_RUN_AS_NODE=1, which would make Electron behave like plain Node.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [root, ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
