// Driver for the markdown-render-speed-02 entry. It reads every case from
// /input/cases.json (or $MAKEFUN_INPUT_DIR outside a container), renders
// each one alone with parse() from parse.js, and writes /output/html.json
// (or $MAKEFUN_OUTPUT_DIR): a JSON array of the HTML strings, one per case,
// in the cases' order.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
