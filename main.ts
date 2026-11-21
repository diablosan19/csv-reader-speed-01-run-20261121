// csv-reader-speed-01-run-20261121 — "Read broken CSV files faster".
//
// The harness runs `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json (a JSON array of {id, input}), answers each one alone,
// and writes /output/answers.json: a JSON array of the answers, one per case
// and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// This driver differs from the house baseline's in one way: solve.js answers
// each case as its JSON text (runJson), so the answers file is assembled by
// joining those texts instead of building an object graph and paying
// JSON.stringify over it. The joined file parses to exactly the array of
// csv-reader's answers, in the cases' order. solve.js still exports run()
// returning the answer as a value, for the module's contract.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { runJson } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  runJson: (input: unknown) => string;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const parts: string[] = ['['];
for (let i = 0; i < cases.length; i++) {
  if (i !== 0) parts.push(',');
  parts.push(runJson(cases[i].input));
}
parts.push(']');
writeFileSync(join(OUTPUT_DIR, 'answers.json'), parts.join(''));
