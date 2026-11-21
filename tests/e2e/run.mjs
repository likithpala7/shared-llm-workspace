#!/usr/bin/env node
// Runs every suite in order against a server that is already up.
//
//   npm run test:e2e            all suites
//   npm run test:e2e -- 03      only suites whose name contains "03"
//
// Suites 01-06 and 08 run against a server that is already up. 09 starts and
// kills its own servers on a scratch data directory. 07-summaries needs a
// server with a small SUMMARY_TOKEN_BUDGET, so the runner skips it; see the
// README for its two-line invocation.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

const suites = fs
  .readdirSync(here)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .filter((f) => (filter ? f.includes(filter) : f !== '07-summaries.mjs'))
  .sort();

const results = [];
for (const suite of suites) {
  console.log(`\n━━━ ${suite} ━━━`);
  const code = await new Promise((resolve) => {
    spawn(process.execPath, [path.join(here, suite)], { stdio: 'inherit' }).on('exit', resolve);
  });
  results.push({ suite, ok: code === 0 });
}

console.log('\n════ summary ════');
for (const { suite, ok } of results) console.log(`${ok ? 'pass' : 'FAIL'}  ${suite}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
