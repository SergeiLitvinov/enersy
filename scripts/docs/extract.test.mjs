import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { declarations, fence } from './extract.mjs';

test('declaration index keeps real line numbers across supported languages', () => {
  for (const [lang, text] of Object.entries({
    julia: 'function solve(a)\nend\nstruct Bus', go: 'func solve() {\n}\ntype Bus struct {',
    rust: 'pub fn solve() {\n}\npub struct Bus {', typescript: 'export async function solve() {\n}\nexport interface Bus {',
    sql: 'CREATE TABLE buses (\n);\nALTER TABLE buses ADD id INT;'
  })) assert.deepEqual(declarations(text, lang).map(d => d.line), [1, 3]);
});

test('source containing fences cannot break generated Markdown', () => {
  assert.equal(fence('```evil\n<script>\n```', 'text'), '````text\n```evil\n<script>\n```\n````');
});

test('comments and imports are not advertised as declarations', () => {
  assert.deepEqual(declarations('// export function fake\nimport X from "x"', 'typescript'), []);
});
