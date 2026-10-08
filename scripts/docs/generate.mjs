import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarations, fence } from './extract.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const site = path.join(root, 'docs/site');
const generated = path.join(site, 'generated');
const sources = path.join(site, 'public/source');
// Delete only outputs owned by this generator; handwritten pages are outside them.
for (const output of [generated, sources]) {
  if (!output.startsWith(site + path.sep)) throw new Error('Output escapes documentation site');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
}
const languages = { '.ts': 'typescript', '.tsx': 'typescript', '.go': 'go', '.jl': 'julia', '.rs': 'rust', '.sql': 'sql' };
const exclude = new Set(['node_modules', 'dist', 'target', '.git', '__pycache__', 'pkg']);
async function walk(relative) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (exclude.has(entry.name)) continue;
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (entry.isFile() && languages[path.extname(file)]) files.push(file);
  }
  return files;
}
const groups = ['frontend/src', 'backend-go', 'backend-julia/src', 'backend-julia/test', 'backend-julia/benchmark', 'rust-wasm/src', 'numerics/src', 'numerics/tests', 'database'];
const files = (await Promise.all(groups.map(walk))).flat().sort();
// Publish only explicitly selected, project-owned measurement artifacts.
const reports = path.join(site, 'public/reports');
await mkdir(reports, { recursive: true });
for (const name of ['sparse-ac-2026-10-03.json', 'storage-snapshot-2026-10-08.json']) {
  await writeFile(path.join(reports, name), await readFile(path.join(root, 'docs/reports', name)));
}
const index = ['# Справочник исходников', '', 'Автоматически собран из текущего рабочего дерева. Индекс объявлений — текстовый: он не разрешает перегрузки и типы. Полные исходники сохраняют комментарии, Julia docstrings и SQL-ограничения. Для транспортного TypeScript API доступна отдельная семантическая документация TypeDoc.', '', '[Открыть TypeScript API](/api/typescript/index.html)', ''];
await mkdir(path.join(generated, 'code'), { recursive: true });
for (const file of files) {
  const code = (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
  const language = languages[path.extname(file)];
  const slug = file.replaceAll('/', '__').replaceAll('.', '_');
  const entries = declarations(code, language);
  const page = [`# ${file}`, '', `[Скачать исходник](/source/${file}.txt)`, '', '## Объявления', '', ...entries.flatMap(d => [`Строка **${d.line}**`, '', fence(d.signature, language), '']), '## Код и комментарии', '', fence(code, language), ''];
  await writeFile(path.join(generated, 'code', slug + '.md'), page.join('\n'));
  const target = path.join(sources, file + '.txt');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, code);
  index.push(`- [${file}](./${slug}) — ${entries.length} объявлений`);
}
await writeFile(path.join(generated, 'code/index.md'), index.join('\n') + '\n');
for (const [input, output] of [['docs/CODING_RULES.md', 'rules'], ['docs/PROJECT_REVIEW.md', 'review'], ['TODO.md', 'todo'], ['docs/IMPLEMENTATION_REVIEW_2026_09_30.md', 'implementation']]) {
  let content = await readFile(path.join(root, input), 'utf8');
  // Repository-relative links become downloads. Never read .env or arbitrary files.
  content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (all, label, href) => {
    if (/^(https?:|#|mailto:)/.test(href)) return all;
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(input), href.split('#')[0]));
    if (relative === 'docs/IMPLEMENTATION_REVIEW_2026_09_30.md') return `[${label}](/generated/implementation)`;
    if (relative === 'TODO.md') return `[${label}](/generated/todo)`;
    if (relative === 'docs/CODING_RULES.md') return `[${label}](/generated/rules)`;
    if (relative === 'docs/PROJECT_REVIEW.md') return `[${label}](/generated/review)`;
    if (files.includes(relative)) return `[${label}](/source/${relative}.txt)`;
    // Old line-oriented references remain readable without an invented remote URL.
    return `${label} (${href})`;
  });
  await writeFile(path.join(generated, output + '.md'), `<!-- Generated from ${input}; edit that file. -->\n\n${content}`);
}
console.log(`Documentation generated: ${files.length} source files, 4 canonical documents.`);
