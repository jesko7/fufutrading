// Downloads the Pyodide wheels FuFu needs (NumPy) into resources/wheels so Python scripting
// works offline from the first start. Checksums come from pyodide-lock.json.
//   node scripts/fetch-wheels.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const PACKAGES = ['numpy'];

export async function fetchWheels({ quiet = false } = {}) {
  const pyDir = path.join(root, 'node_modules', 'pyodide');
  const lock = JSON.parse(fs.readFileSync(path.join(pyDir, 'pyodide-lock.json'), 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(pyDir, 'package.json'), 'utf8')).version;
  const out = path.join(root, 'resources', 'wheels');
  fs.mkdirSync(out, { recursive: true });
  for (const name of PACKAGES) {
    const pkg = lock.packages[name];
    if (!pkg) throw new Error(`${name} missing from pyodide-lock.json`);
    const dst = path.join(out, pkg.file_name);
    if (fs.existsSync(dst) && sha256(fs.readFileSync(dst)) === pkg.sha256) continue;
    const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${pkg.file_name}`;
    if (!quiet) console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sum = sha256(buf);
    if (sum !== pkg.sha256) throw new Error(`${pkg.file_name}: checksum mismatch (${sum})`);
    fs.writeFileSync(dst, buf);
  }
  return out;
}

function sha256(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  fetchWheels()
    .then((d) => console.log(`wheels ready in ${d}`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
