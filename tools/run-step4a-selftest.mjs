/**
 * Headless Step 4a self-test (no WebView).
 * Usage: node tools/run-step4a-selftest.mjs
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
  CSPACK_V2_EPS: undefined,
};
vm.createContext(context);
const code = fs.readFileSync(packPath, 'utf8');
vm.runInContext(code, context, { filename: packPath });

const out = context.csPackV2Step4aSelfTest();
console.log(JSON.stringify(out, null, 2));
process.exit(out && out.ok ? 0 : 1);
