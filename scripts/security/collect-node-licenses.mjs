import { readdir, readFile, realpath, stat, mkdir, writeFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const noticeName = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$|^third.*(?:notice|licen[cs]e).*$/i;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Recognize bounded ELF/PE/core-WASM headers, not executable correctness or licensing. */
async function collectBinaryFiles(directory, bindings) {
  const visited = new Set(), files = [];
  let entries = 0;
  async function walk(candidate, relative, depth) {
    if (depth > 32) throw new Error('Dependency binary scan exceeds directory depth');
    const resolved = await realpath(candidate);
    if (resolved !== directory && !resolved.startsWith(directory + path.sep)) throw new Error('Dependency binary scan escapes its package');
    const info = await stat(resolved);
    if (info.isDirectory()) {
      if (visited.has(resolved)) return;
      visited.add(resolved);
      for (const name of (await readdir(resolved)).sort()) {
        if (name === 'node_modules' || name === '.git') continue;
        if (++entries > 100000) throw new Error('Dependency binary scan exceeds entry limit');
        await walk(path.join(resolved, name), relative ? `${relative}/${name}` : name, depth + 1);
      }
      return;
    }
    if (!info.isFile() || info.size < 8) return;
    const handle = await open(resolved, 'r');
    let format;
    try {
      const header = Buffer.alloc(64);
      const { bytesRead } = await handle.read(header, 0, 64, 0);
      if (bytesRead >= 52 && header.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) &&
          [1, 2].includes(header[4]) && [1, 2].includes(header[5]) && header[6] === 1 &&
          (header[4] === 1 || bytesRead >= 64)) format = 'ELF';
      else if (header.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) format = 'WASM';
      else if (bytesRead === 64 && header[0] === 77 && header[1] === 90) {
        const offset = header.readUInt32LE(60);
        if (offset >= 64 && offset <= info.size - 4) {
          const signature = Buffer.alloc(4);
          const read = await handle.read(signature, 0, 4, offset);
          if (read.bytesRead === 4 && signature.equals(Buffer.from([80, 69, 0, 0]))) format = 'PE';
        }
      }
    } finally { await handle.close(); }
    if (!format) return;
    if (info.size > 64 * 1024 * 1024) throw new Error('Dependency binary exceeds 64 MiB');
    const digest = createHash('sha256'); let size = 0;
    for await (const chunk of createReadStream(resolved)) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error('Dependency binary exceeds 64 MiB');
      digest.update(chunk);
    }
    if (size !== info.size) throw new Error('Dependency binary changed during inventory');
    const hash = digest.digest('hex');
    files.push({ path: relative, format, bytes: size, sha256: hash, reviewedFileBinding: bindings.get(relative) === hash });
  }
  await walk(directory, '', 0);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function validateLinkedNotice(source) {
  const reference = source.linkedNotice;
  if (reference === undefined) return;
  if (source.kind !== 'reviewed-upstream' || !reference || Array.isArray(reference) ||
      Object.keys(reference).sort().join(',') !== 'declaredURL,file,retrievedURL,sha256' ||
      typeof reference.file !== 'string' || !reference.file || /[/\\]/.test(reference.file) ||
      reference.file === '.' || reference.file === '..' || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? '') ||
      !source.sourceURL.endsWith(`/${reference.file}`)) throw new Error('Invalid linked notice reference');
  let declared, retrieved;
  try {
    declared = new URL(reference.declaredURL);
    retrieved = new URL(reference.retrievedURL);
  } catch { throw new Error('Invalid linked notice URL'); }
  if (!['http:', 'https:'].includes(declared.protocol) || retrieved.protocol !== 'https:' ||
      declared.username || declared.password || retrieved.username || retrieved.password || declared.hash || retrieved.hash) {
    throw new Error('Invalid linked notice URL');
  }
  declared.protocol = 'https:';
  if (declared.href !== retrieved.href) throw new Error('Linked notice retrieval changed the author reference');
}

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
    if (source.coverage !== undefined && source.coverage !== 'supplemental') throw new Error('Invalid reviewed notice coverage');
    if (source.installedFiles !== undefined) {
      const entries = source.installedFiles && typeof source.installedFiles === 'object' && !Array.isArray(source.installedFiles) ? Object.entries(source.installedFiles) : [];
      if (!entries.length || entries.length > 32 || entries.some(([file, digest]) =>
        /[\\:\p{Cc}]/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..') ||
        typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) throw new Error('Invalid reviewed installed file binding');
    }
    if (source.kind !== undefined && (source.kind !== 'reviewed-upstream' ||
        !/^[a-f0-9]{40}$/.test(source.sourceCommit ?? '') ||
        typeof source.sourceURL !== 'string' || !source.sourceURL.startsWith('https://') ||
        !source.sourceURL.includes(`/${source.sourceCommit}/`))) throw new Error('Invalid reviewed upstream source');
    validateLinkedNotice(source);
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
        if (source.linkedNotice) {
          const reference = source.linkedNotice;
          const declaration = await safePath(path.join(directory, reference.file));
          if (!declaration.startsWith(directory + path.sep)) throw new Error('Linked declaration escapes its package');
          const metadata = await stat(declaration);
          if (!metadata.isFile() || metadata.size === 0 || metadata.size > 1024 * 1024) throw new Error('Invalid linked declaration file');
          const bytes = await readFile(declaration);
          if (sha256(bytes) !== reference.sha256) throw new Error('Linked declaration content changed');
          if (!utf8.decode(bytes).includes(`](${reference.declaredURL})`)) throw new Error('Author notice link is absent from the reviewed declaration');
        }
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
      const text = utf8.decode(content);
      const empty = !/[^\s\p{Cc}\p{Cf}]/u.test(text);
      notices[digest] = { sha256: digest, text };
      const provenance = source ? { kind: source.kind ?? 'reviewed-embedded',
        ...(source.coverage ? { coverage: source.coverage } : {}),
        ...(source.installedFiles ? { installedFiles: { ...source.installedFiles } } : {}),
        ...(typeof source.reason === 'string' ? { reviewReason: source.reason } : {}),
        ...(typeof source.reviewedUtc === 'string' ? { reviewedUtc: source.reviewedUtc } : {}),
        ...(source.kind === 'reviewed-upstream' ? { sourceCommit: source.sourceCommit, sourceURL: source.sourceURL,
          ...(source.linkedNotice ? { linkedNotice: { ...source.linkedNotice } } : {}) } : {}) } : {};
      files.push({ name: item, sha256: digest, ...provenance, ...(empty ? { empty: true } : {}) });
    }
    for (const item of (await readdir(directory)).sort()) {
      if (!noticeName.test(item)) continue;
      const file = await safePath(path.join(directory, item));
      if (!(await stat(file)).isFile()) continue;
      await captureNotice(item);
    }
    for (const source of reviewed.get(`${pkg.name}@${pkg.version}`) ?? []) {
      if (sha256(bytes) !== source.manifestSha256) throw new Error('Reviewed notice package manifest changed');
      for (const [relative, expected] of Object.entries(source.installedFiles ?? {})) {
        const file = await safePath(path.join(directory, relative));
        if (!file.startsWith(directory + path.sep)) throw new Error('Reviewed installed file escapes its package');
        const metadata = await stat(file);
        if (!metadata.isFile() || metadata.size === 0 || metadata.size > 64 * 1024 * 1024) throw new Error('Invalid reviewed installed file');
        const data = await readFile(file);
        if (data.length > 64 * 1024 * 1024 || sha256(data) !== expected) throw new Error('Reviewed installed file content changed');
      }
      if (source.kind === 'reviewed-upstream' || !files.some(file => file.name === source.file)) await captureNotice(source.file, source);
      else {
        const file = files.find(file => file.name === source.file);
        if (file.sha256 !== source.sha256) throw new Error('Reviewed notice content changed');
        if (source.coverage) Object.assign(file, { coverage: source.coverage,
          ...(typeof source.reason === 'string' ? { reviewReason: source.reason } : {}) });
        if (source.installedFiles) file.installedFiles = { ...source.installedFiles };
      }
    }
    const declaredLicense = pkg.license ?? null;
    const bindings = new Map((reviewed.get(`${pkg.name}@${pkg.version}`) ?? []).flatMap(source => Object.entries(source.installedFiles ?? {})));
    const binaryFiles = await collectBinaryFiles(directory, bindings);
    const record = {
      name: pkg.name, version: pkg.version, manifestSha256: sha256(bytes),
      declaredLicense, noticeFiles: files, binaryFiles,
      incompleteEvidence: typeof declaredLicense !== 'string' || !declaredLicense.trim() || !files.some(file => !file.empty && file.coverage !== 'supplemental'),
    };
    // Physical installs can have identical manifests but different notices/binaries.
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
  const binaries = packages.flatMap(pkg => pkg.binaryFiles);
  return {
    format: 1, capturedUtc: new Date().toISOString(),
    project: { name: project.name, version: project.version ?? null, declaredLicense: project.license ?? null },
    lock: { file: path.basename(lockFile), sha256: sha256(lock) },
    packageCount: packages.length, incompleteEvidenceCount: packages.filter(p => p.incompleteEvidence).length,
    binaryFileCount: binaries.length, uniqueBinaryCount: new Set(binaries.map(file => file.sha256)).size,
    unboundBinaryFileCount: binaries.filter(file => !file.reviewedFileBinding).length,
    packages,
    notices: Object.fromEntries(Object.entries(notices).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    limitations: [
      'Installed packages on this platform, including development dependencies; not the final bundle composition',
      'Optional packages absent on this platform are not inventoried',
      'Package license metadata and notice files are evidence, not a license compatibility decision',
      'A captured package root notice does not establish coverage of native binary dependencies; reviewReason preserves narrower reviewed scopes',
      'Embedded and upstream notices are included only for explicitly reviewed name/version, manifest and file hashes',
      'Optional installedFiles bindings verify reviewed package files too; they do not establish full native binary attribution',
      'binaryFiles recognizes ELF, PE and core WASM v1 headers only; other formats, loaded libraries and final bundle composition are not established',
      'reviewedFileBinding is a package-scoped integrity binding, not proof of complete binary licensing; node_modules is scanned as separate packages',
      'Empty/invisible notices and supplemental third-party notices alone do not complete package notice evidence',
      'Author-linked notices are reviewed byte snapshots bound to an installed declaration and explicit URL; links are not fetched during inventory',
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
  console.log(`${report.binaryFileCount} recognized binary paths; ${report.unboundBinaryFileCount} lack reviewed package file bindings`);
}
