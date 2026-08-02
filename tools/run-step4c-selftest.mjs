/**
 * Headless Step 4c self-test (no WebView).
 * Usage: node tools/run-step4c-selftest.mjs
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

const out = context.csPackV2Step4cSelfTest();
console.log(JSON.stringify(out, null, 2));
process.exit(out && out.ok ? 0 : 1);
