import { readdir, readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const noticeName = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$|^third.*(?:notice|licen[cs]e).*$/i;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Inventory an installed npm/pnpm tree without importing package code.
 * Declared licenses and captured notices still require release review.
 */
export async function collectNodeLicenses(projectRoot, lockFile, reviewedSources = [], upstreamRoot = fileURLToPath(new URL('./node-notices', import.meta.url))) {
  const reviewed = new Map();
  if (!Array.isArray(reviewedSources)) throw new Error('Reviewed notice sources must be an array');
  for (const source of reviewedSources) {
    if (!source || typeof source.name !== 'string' || !source.name ||
      typeof source.version !== 'string' || !source.version ||
      typeof source.file !== 'string' || !source.file ||
      /[/\\]/.test(source.file) || source.file === '.' || source.file === '..' ||
      !/^[a-f0-9]{64}$/.test(source.manifestSha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')) {
      throw new Error('Invalid reviewed notice source');
    }
    if (source.kind !== undefined && (source.kind !== 'reviewed-upstream' ||
        !/^[a-f0-9]{40}$/.test(source.sourceCommit ?? '') ||
        typeof source.sourceURL !== 'string' || !source.sourceURL.startsWith('https://') ||
        !source.sourceURL.includes(`/${source.sourceCommit}/`))) throw new Error('Invalid reviewed upstream source');
    const key = `${source.name}@${source.version}`;
    const sources = reviewed.get(key) ?? [];
    if (sources.some(item => item.file === source.file)) throw new Error('Duplicate reviewed notice source');
    if (sources.some(item => item.manifestSha256 !== source.manifestSha256)) throw new Error('Inconsistent reviewed package manifest');
    reviewed.set(key, [...sources, source]);
  }
  const root = await realpath(projectRoot);
  const modules = await realpath(path.join(root, 'node_modules'));
  const insideModules = value => value === modules || value.startsWith(modules + path.sep);
  const lock = await readFile(lockFile);
  const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const visitedPackages = new Set();
  const visitedModules = new Set();
  const records = new Map();
  const notices = {};

  async function safePath(candidate) {
    const resolved = await realpath(candidate);
    if (!insideModules(resolved)) throw new Error('Dependency path escapes node_modules');
    return resolved;
  }

  async function packageAt(candidate) {
    const directory = await safePath(candidate);
    if (visitedPackages.has(directory)) return;
    visitedPackages.add(directory);
    const manifestPath = await safePath(path.join(directory, 'package.json'));
    const bytes = await readFile(manifestPath);
    const pkg = JSON.parse(utf8.decode(bytes).replace(/^\uFEFF/, ''));
    if (typeof pkg.name !== 'string' || !pkg.name || typeof pkg.version !== 'string' || !pkg.version) {
      throw new Error('Installed package has no name/version');
    }
    const files = [];
    async function captureNotice(item, source) {
      let file;
      if (source?.kind === 'reviewed-upstream') {
        const origin = await realpath(upstreamRoot);
        file = await realpath(path.join(origin, item));
        if (!file.startsWith(origin + path.sep)) throw new Error('Reviewed upstream notice escapes its root');
      } else {
        file = await safePath(path.join(directory, item));
        if (source && !file.startsWith(directory + path.sep)) throw new Error('Reviewed notice escapes its package');
      }
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Dependency notice is not a file');
      if (source?.kind === 'reviewed-upstream' && info.size === 0) throw new Error('Reviewed upstream notice is empty');
      if (info.size > 1024 * 1024) throw new Error('Dependency notice exceeds 1 MiB');
      const content = await readFile(file);
      const digest = sha256(content);
      if (source && digest !== source.sha256) throw new Error('Reviewed notice content changed');
      notices[digest] = { sha256: digest, text: utf8.decode(content) };
      files.push({ name: item, sha256: digest, ...(source ? { kind: source.kind ?? 'reviewed-embedded',
        ...(source.kind === 'reviewed-upstream' ? { sourceCommit: source.sourceCommit, sourceURL: source.sourceURL } : {}) } : {}) });
    }
    for (const item of (await readdir(directory)).sort()) {
      if (!noticeName.test(item)) continue;
      const file = await safePath(path.join(directory, item));
      if (!(await stat(file)).isFile()) continue;
      await captureNotice(item);
    }
    for (const source of reviewed.get(`${pkg.name}@${pkg.version}`) ?? []) {
      if (sha256(bytes) !== source.manifestSha256) throw new Error('Reviewed notice package manifest changed');
      if (source.kind === 'reviewed-upstream' || !files.some(file => file.name === source.file)) await captureNotice(source.file, source);
      else {
        if (files.find(file => file.name === source.file).sha256 !== source.sha256) throw new Error('Reviewed notice content changed');
      }
    }
    const declaredLicense = pkg.license ?? null;
    const record = {
      name: pkg.name, version: pkg.version, manifestSha256: sha256(bytes),
      declaredLicense, noticeFiles: files,
      incompleteEvidence: typeof declaredLicense !== 'string' || !declaredLicense.trim() || files.length === 0,
    };
    // Two physical installs can have identical manifests but different notices.
    const identity = `${pkg.name}@${pkg.version}:${sha256(JSON.stringify(record))}`;
    records.set(identity, record);
    await scanModules(path.join(directory, 'node_modules'));
  }

  async function scanModules(candidate) {
    let directory;
    try { directory = await safePath(candidate); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (visitedModules.has(directory)) return;
    visitedModules.add(directory);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === '.pnpm') {
        const store = await safePath(path.join(directory, entry.name));
        for (const installed of (await readdir(store, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
          if (!installed.isDirectory() && !installed.isSymbolicLink()) continue;
          if (installed.name === 'node_modules') await scanModules(path.join(store, installed.name));
          else await scanModules(path.join(store, installed.name, 'node_modules'));
        }
      } else if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) {
        const target = path.join(directory, entry.name);
        if (entry.name.startsWith('@')) {
          const scope = await safePath(target);
          for (const item of await readdir(scope, { withFileTypes: true })) {
            if (!item.name.startsWith('.') && (item.isDirectory() || item.isSymbolicLink())) {
              await packageAt(path.join(scope, item.name));
            }
          }
        } else await packageAt(target);
      }
    }
  }

  await scanModules(modules);
  if (records.size === 0) throw new Error('Installed dependency inventory is empty');
  const packages = [...records.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, value]) => value);
  return {
    format: 1, capturedUtc: new Date().toISOString(),
    project: { name: project.name, version: project.version ?? null, declaredLicense: project.license ?? null },
    lock: { file: path.basename(lockFile), sha256: sha256(lock) },
    packageCount: packages.length, incompleteEvidenceCount: packages.filter(p => p.incompleteEvidence).length,
    packages,
    notices: Object.fromEntries(Object.entries(notices).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    limitations: [
      'Installed packages on this platform, including development dependencies; not the final bundle composition',
      'Optional packages absent on this platform are not inventoried',
      'Package license metadata and notice files are evidence, not a license compatibility decision',
      'Embedded and upstream notices are included only for explicitly reviewed name/version, manifest and file hashes',
      'Non-npm dependencies, operating-system packages and other non-root notice files require separate review',
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error('Usage: collect-node-licenses.mjs PROJECT_ROOT LOCK_FILE REPORT_FILE');
  const [, , root, lock, output] = process.argv;
  const reviewed = JSON.parse(await readFile(new URL('./node-notice-sources.json', import.meta.url), 'utf8'));
  const report = await collectNodeLicenses(root, lock, reviewed);
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.packageCount} installed packages; ${report.incompleteEvidenceCount} have incomplete license/notice evidence`);
}
