/**
 * Headless Step 4 full self-test (4a–4f wired).
 * Usage: node tools/run-step4-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const packPath = path.join(root, 'viewer', 'js', '18-cs-pack-v2.js');

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
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(packPath, 'utf8'), context, { filename: packPath });

const out = context.csPackV2Step4SelfTest();
console.log(JSON.stringify({
  ok: out.ok,
  passed: out.passed,
  total: out.total,
  fails: (out.results || []).filter(r => !r.ok),
}, null, 2));
process.exit(out && out.ok ? 0 : 1);
