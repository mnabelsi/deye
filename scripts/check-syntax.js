'use strict';

// `npm run check`: syntax-checks every server and browser JavaScript file.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  const isModule = f.includes(`${path.sep}public${path.sep}`);
  try {
    if (isModule) {
      // Browser ES modules: check as module source via a data URL import-less parse.
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(f), stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } catch (err) {
    failed += 1;
    console.error(`✗ ${path.relative(root, f)}\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}
console.log(failed ? `${failed} file(s) failed` : `✓ ${files.length} files OK`);
process.exit(failed ? 1 : 0);
