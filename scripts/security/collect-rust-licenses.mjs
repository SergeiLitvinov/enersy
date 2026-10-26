import { readFile, readdir, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hex = /^[a-f0-9]{64}$/;
const crateName = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const crateVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$/;
const noticeName = /^(?:licen[cs]e|copying|notice|copyright|patents)(?:[-_][a-z0-9-]+)?(?:\.(?:txt|md|markdown|rst|text|html))?$|^third[-_]?party[-_ ]?(?:notices?|licen[cs]es?)(?:\.(?:txt|md|markdown|rst|text|html))?$/i;
const cratesIO = 'registry+https://github.com/rust-lang/crates.io-index';

function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid notice file path');
  return value;
}

async function checked(root, file) {
  const candidate = await realpath(path.join(root, relativeFile(file)));
  if (!candidate.startsWith(root + path.sep)) throw new Error('Notice source escapes its input directory');
  return candidate;
}

/** Read Cargo's resolved graph and checksum-bearing vendor tree; never execute crate code.
 * The build stage generates inputs with locked/offline Cargo and copies SDK stdlib notices.
 */
export async function collectRustLicenses(inputDirectory) {
  const root = await realpath(inputDirectory);
  const readInput = async file => readFile(await checked(root, file));
  const inputSourceDirectory = async file => {
    const resolved = await checked(root, file);
    if (resolved !== path.join(root, file) || !(await stat(resolved)).isDirectory()) {
      throw new Error('Input directory aliases another source or is not a directory');
    }
    return resolved;
  };
  const metadataBytes = await readInput('metadata.json');
  const metadata = JSON.parse(utf8.decode(metadataBytes));
  if (metadata.version !== 1 || !Array.isArray(metadata.packages) || !Array.isArray(metadata.resolve?.nodes) ||
    typeof metadata.resolve.root !== 'string') throw new Error('Cargo metadata has no rooted resolved graph');
  const packages = new Map();
  const nodes = new Map();
  for (const pkg of metadata.packages) {
    if (!pkg || typeof pkg.id !== 'string' || packages.has(pkg.id) || typeof pkg.name !== 'string' ||
      typeof pkg.version !== 'string' || !crateName.test(pkg.name) || !crateVersion.test(pkg.version)) {
      throw new Error('Invalid or duplicate Cargo package identity');
    }
    packages.set(pkg.id, pkg);
  }
  for (const node of metadata.resolve.nodes) {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id) || !Array.isArray(node.dependencies)) throw new Error('Invalid Cargo resolve node');
    nodes.set(node.id, node);
  }
  const selected = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length) {
    const id = pending.pop();
    if (selected.has(id)) continue;
    const node = nodes.get(id);
    if (!node || !packages.has(id)) throw new Error('Incomplete Cargo resolved graph');
    selected.add(id);
    pending.push(...node.dependencies);
  }
  const notices = {};
  async function capture(directory, file, expected) {
    const source = await checked(directory, file);
    const info = await stat(source);
    if (!info.isFile() || info.size === 0 || info.size > 4 * 1024 * 1024) throw new Error('Invalid notice file size or type');
    const data = await readFile(source);
    const digest = hash(data);
    if (expected !== undefined && (!hex.test(expected) || digest !== expected)) throw new Error('Vendored notice checksum mismatch');
    notices[digest] = utf8.decode(data);
    return { name: file, sha256: digest };
  }
  const records = [];
  for (const id of selected) {
    const pkg = packages.get(id);
    const local = id === metadata.resolve.root;
    if (local ? pkg.source !== null : pkg.source !== cratesIO) throw new Error('Unsupported Cargo package source; provenance review required');
    const directory = await inputSourceDirectory(local ? 'project' : `vendor/${pkg.name}-${pkg.version}`);
    let checksums;
    if (!local) {
      checksums = JSON.parse(utf8.decode(await readFile(await checked(directory, '.cargo-checksum.json'))));
      if (!hex.test(checksums.package ?? '') || !checksums.files || Array.isArray(checksums.files) || typeof checksums.files !== 'object') {
        throw new Error('Invalid Cargo vendor checksum manifest');
      }
    }
    const manifest = await readFile(await checked(directory, 'Cargo.toml'));
    const manifestSha256 = hash(manifest);
    if (!local && checksums.files['Cargo.toml'] !== manifestSha256) throw new Error('Vendored Cargo manifest checksum mismatch');
    const files = new Set();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && noticeName.test(entry.name)) files.add(entry.name);
    }
    if (pkg.license_file != null) files.add(relativeFile(pkg.license_file));
    const noticeFiles = [];
    for (const file of [...files].sort()) {
      if (!local && !Object.hasOwn(checksums.files, file)) throw new Error('Notice is absent from Cargo vendor checksums');
      noticeFiles.push(await capture(directory, file, local ? undefined : checksums.files[file]));
    }
    records.push({ name: pkg.name, version: pkg.version, source: local ? 'project' : pkg.source,
      packageChecksum: local ? null : checksums.package, manifestSha256,
      declaredLicense: pkg.license ?? null, noticeFiles,
      incompleteEvidence: noticeFiles.length === 0 || !(typeof pkg.license === 'string' && pkg.license.trim() || pkg.license_file) });
  }
  records.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  const compiler = utf8.decode(await readInput('compiler.txt')).trim();
  const release = /^release: ([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(compiler)?.[1];
  const host = /^host: ([a-zA-Z0-9_-]+)$/m.exec(compiler)?.[1];
  const target = utf8.decode(await readInput('target.txt')).trim();
  const artifactName = utf8.decode(await readInput('artifact-name.txt')).trim();
  if (!release || !host || !/^[a-zA-Z0-9_-]+$/.test(target) || !/^[a-zA-Z0-9_.-]+$/.test(artifactName)) throw new Error('Invalid compiler or artifact identity');
  const toolchain = await inputSourceDirectory('toolchain');
  const copyright = await capture(toolchain, 'COPYRIGHT-library.html');
  const toolchainFiles = [copyright];
  const licenseDirectory = await checked(toolchain, 'licenses');
  for (const file of (await readdir(licenseDirectory)).sort()) {
    if (!file.endsWith('.txt')) throw new Error('Unexpected Rust SDK license bundle file');
    toolchainFiles.push(await capture(toolchain, `licenses/${file}`));
  }
  const includedFiles = new Set(toolchainFiles.map(file => file.name));
  for (const match of notices[copyright.sha256].matchAll(/href="(licenses\/[^"#?]+)"/g)) {
    if (!includedFiles.has(match[1])) throw new Error('Rust standard-library notice references a missing license');
  }
  if (!includedFiles.has('licenses/MIT.txt') || !includedFiles.has('licenses/Apache-2.0.txt')) throw new Error('Incomplete Rust standard-library license bundle');
  const artifact = await readInput('artifact');
  if (artifact.length === 0) throw new Error('Empty Rust artifact');
  return {
    formatVersion: 1, scope: 'cargo-resolved-build-graph-notices', capturedUtc: new Date().toISOString(),
    artifact: { name: artifactName, target, bytes: artifact.length, sha256: hash(artifact) },
    inputs: { metadataSha256: hash(metadataBytes), manifestSha256: hash(await readInput('project/Cargo.toml')), lockSha256: hash(await readInput('project/Cargo.lock')) },
    compiler: { release, host }, packageCount: records.length,
    incompleteEvidenceCount: records.filter(record => record.incompleteEvidence).length,
    packages: records, standardLibrary: { noticeFiles: toolchainFiles }, notices,
    limitations: [
      'Resolved Cargo graph includes host build/proc-macro and platform dependencies; not proof of final binary linkage',
      'Only crates.io dependencies and the root project are supported; other sources require provenance review',
      'Cargo vendor checksums detect changed files in a trusted build; they do not authenticate modified inputs or toolchains',
      'SDK-provided standard-library notice bundle; not a license compatibility or source-file attribution audit',
      'Operating-system and other native libraries require separate inventories',
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: collect-rust-licenses.mjs INPUT_DIRECTORY REPORT.json');
  const report = await collectRustLicenses(process.argv[2]);
  await mkdir(path.dirname(path.resolve(process.argv[3])), { recursive: true });
  await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.packageCount} resolved Rust packages; ${report.incompleteEvidenceCount} have incomplete notice evidence`);
}
