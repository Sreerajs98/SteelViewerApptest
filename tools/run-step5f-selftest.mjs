/**
 * Headless Step 5f + full Step5 suite.
 * Usage:
 *   node tools/run-step5f-selftest.mjs
 *   node tools/run-step5f-selftest.mjs --full
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const packPath = path.join(root, 'viewer', 'js', '18-cs-pack-v2.js');
const full = process.argv.includes('--full');

const context = {
  console,
  Math,
  Number,
  String,
  Array,
  Object,
  JSON,
  Infinity,
  NaN,
  Set,
  Map,
  RegExp,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(packPath, 'utf8'), context, { filename: packPath });

const out = full
  ? context.csPackV2Step5SelfTest()
  : context.csPackV2Step5fSelfTest({ skipRegression: false });

console.log(JSON.stringify({
  mode: full ? 'step5_full' : 'step5f',
  ok: out.ok,
  passed: out.passed,
  total: out.total,
  sample: out.sample || null,
  fails: (out.results || []).filter(r => !r.ok),
}, null, 2));
process.exit(out && out.ok ? 0 : 1);
