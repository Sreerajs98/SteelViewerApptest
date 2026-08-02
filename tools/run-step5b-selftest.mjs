/**
 * Headless Step 5b self-test (apply placements to targets/meshes).
 * Usage: node tools/run-step5b-selftest.mjs
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
  Set,
  Map,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(packPath, 'utf8'), context, { filename: packPath });

const out = context.csPackV2Step5bSelfTest();
console.log(JSON.stringify({
  ok: out.ok,
  passed: out.passed,
  total: out.total,
  sample: out.sample || null,
  fails: (out.results || []).filter(r => !r.ok),
}, null, 2));
process.exit(out && out.ok ? 0 : 1);
