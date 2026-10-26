import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectRustLicenses } from './collect-rust-licenses.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const registry = 'registry+https://github.com/rust-lang/crates.io-index';

async function fixture(t, notices = { LICENSE: 'Crate permission and disclaimer' }) {
  const root = await mkdtemp(path.join(tmpdir(), 'enersy-rust-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (file, data) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), data);
  };
  const local = { name: 'fixture', version: '0.1.0', id: 'path+file:///private-build#fixture@0.1.0', source: null, license: 'MIT', license_file: null };
  const crate = { name: 'dependency', version: '1.2.3', id: `${registry}#dependency@1.2.3`, source: registry, license: 'MIT', license_file: null };
  const metadata = { version: 1, packages: [local, crate], resolve: { root: local.id, nodes: [
    { id: local.id, dependencies: [crate.id] }, { id: crate.id, dependencies: [] },
  ] } };
  await write('metadata.json', JSON.stringify(metadata));
  await write('project/Cargo.toml', '[package]\nname = "fixture"\nversion = "0.1.0"\nlicense = "MIT"\n');
  await write('project/Cargo.lock', '# frozen fixture lock\nversion = 4\n');
  await write('project/LICENSE', '\ufeffCopyright © Авторы\r\nPermission and disclaimer\r\n');
  await write('compiler.txt', 'rustc 1.99.1 (fixture)\nhost: x86_64-unknown-linux-gnu\nrelease: 1.99.1\n');
  await write('target.txt', 'wasm32-unknown-unknown\n');
  await write('artifact-name.txt', 'fixture.wasm\n');
  await write('artifact', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await write('toolchain/COPYRIGHT-library.html', '<h1>Standard library</h1><a href="licenses/MIT.txt">MIT</a>');
  await write('toolchain/licenses/MIT.txt', 'SDK MIT permission text');
  await write('toolchain/licenses/Apache-2.0.txt', 'SDK Apache permission text');
  const manifest = '[package]\nname = "dependency"\nversion = "1.2.3"\n';
  const files = { 'Cargo.toml': hash(manifest) };
  await write('vendor/dependency-1.2.3/Cargo.toml', manifest);
  for (const [file, text] of Object.entries(notices)) {
    await write(`vendor/dependency-1.2.3/${file}`, text);
    files[file] = hash(text);
  }
  await write('vendor/dependency-1.2.3/.cargo-checksum.json', JSON.stringify({ package: 'a'.repeat(64), files }));
  return { root, write, metadata, crate, local };
}

test('binds resolved crates, original notice bytes and the artifact without exposing build paths', async t => {
  const { root, write, metadata } = await fixture(t);
  metadata.packages.push({ name: 'unused', version: '9.0.0', id: 'unused', source: 'git+https://example.invalid/unused' });
  await write('metadata.json', JSON.stringify(metadata));
  const report = await collectRustLicenses(root);
  assert.equal(report.packageCount, 2);
  assert.equal(report.incompleteEvidenceCount, 0);
  assert.equal(report.packages[0].packageChecksum, 'a'.repeat(64));
  assert.equal(report.artifact.sha256, hash(await readFile(path.join(root, 'artifact'))));
  assert.equal(report.inputs.lockSha256, hash(await readFile(path.join(root, 'project/Cargo.lock'))));
  assert.doesNotMatch(JSON.stringify(report), /private-build|enersy-rust-notices-/);
  const roundtrip = JSON.parse(JSON.stringify(report));
  for (const [expected, text] of Object.entries(roundtrip.notices)) assert.equal(hash(text), expected);
  assert.ok(Object.values(roundtrip.notices).includes('\ufeffCopyright © Авторы\r\nPermission and disclaimer\r\n'));
});

test('refuses changed Cargo notices and manifests instead of silently accepting same-version replacements', async t => {
  const { root, write } = await fixture(t);
  await write('vendor/dependency-1.2.3/LICENSE', 'Changed permission');
  await assert.rejects(collectRustLicenses(root), /notice checksum mismatch/);
  await write('vendor/dependency-1.2.3/LICENSE', 'Crate permission and disclaimer');
  await write('vendor/dependency-1.2.3/Cargo.toml', '[package]\nname = "changed"');
  await assert.rejects(collectRustLicenses(root), /manifest checksum mismatch/);
});

test('missing crate notice remains incomplete and declared custom files are captured with checksums', async t => {
  const missing = await fixture(t, {});
  const report = await collectRustLicenses(missing.root);
  assert.equal(report.incompleteEvidenceCount, 1);
  assert.equal(report.packages.find(pkg => pkg.name === 'dependency').declaredLicense, 'MIT');
  const custom = await fixture(t, { 'legal/permission.txt': 'Custom license text' });
  custom.crate.license = null;
  custom.crate.license_file = 'legal/permission.txt';
  await custom.write('metadata.json', JSON.stringify(custom.metadata));
  const captured = await collectRustLicenses(custom.root);
  assert.equal(captured.incompleteEvidenceCount, 0);
  assert.equal(captured.packages[0].noticeFiles[0].name, 'legal/permission.txt');
});

test('rejects escaping paths, unrelated sources and incomplete resolution graphs', async t => {
  const { root, write, metadata, crate } = await fixture(t);
  const file = path.join(root, 'vendor/dependency-1.2.3/LICENSE');
  await rm(file);
  const outside = path.join(root, 'other-crate-license.txt');
  await writeFile(outside, 'Crate permission and disclaimer');
  await symlink(outside, file);
  await assert.rejects(collectRustLicenses(root), /escapes/);
  await rm(file);
  await write('vendor/dependency-1.2.3/LICENSE', 'Crate permission and disclaimer');
  const directory = path.dirname(file);
  const alias = directory + '-alias';
  await rename(directory, alias);
  await symlink(alias, directory, 'dir');
  await assert.rejects(collectRustLicenses(root), /directory aliases another source/);
  await rm(directory);
  await rename(alias, directory);
  crate.license_file = '../other-crate-license.txt';
  await write('metadata.json', JSON.stringify(metadata));
  await assert.rejects(collectRustLicenses(root), /Invalid notice file path/);
  crate.license_file = null;
  crate.source = 'git+https://example.invalid/other';
  await write('metadata.json', JSON.stringify(metadata));
  await assert.rejects(collectRustLicenses(root), /Unsupported Cargo package source/);
  crate.source = registry;
  metadata.resolve.nodes = metadata.resolve.nodes.slice(0, 1);
  await write('metadata.json', JSON.stringify(metadata));
  await assert.rejects(collectRustLicenses(root), /Incomplete Cargo resolved graph/);
});

test('standard-library bundle must contain referenced texts and valid notices', async t => {
  const { root, write } = await fixture(t);
  await write('toolchain/COPYRIGHT-library.html', '<a href="licenses/missing.txt">missing license</a>');
  await assert.rejects(collectRustLicenses(root), /references a missing license/);
  await write('toolchain/COPYRIGHT-library.html', Buffer.from([0xff]));
  await assert.rejects(collectRustLicenses(root), /encoded data|encoding/i);
});
