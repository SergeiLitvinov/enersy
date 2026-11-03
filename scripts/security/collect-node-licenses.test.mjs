import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectNodeLicenses } from './collect-node-licenses.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'enersy-licenses-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', license: 'MIT' }));
  const lock = path.join(root, 'package-lock.json');
  await writeFile(lock, '{}');
  const add = async (relative, name, version, license = 'MIT', notices = { LICENSE: 'Fixture permission and copyright notice' }) => {
    const target = path.join(root, 'node_modules', relative);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ name, version, ...(license ? { license } : {}) }));
    for (const [file, text] of Object.entries(notices)) await writeFile(path.join(target, file), text);
    return target;
  };
  return { root, lock, add };
}

test('captures scoped packages, nested versions and third-party notices without executing code', async t => {
  const { root, lock, add } = await fixture(t);
  await add('@scope/tool', '@scope/tool', '2.0.0');
  await add('shared', 'shared', '1.0.0');
  const nested = await add('@scope/tool/node_modules/shared', 'shared', '0.9.0', 'BSD-3-Clause', { 'ThirdPartyNoticeText.txt': 'Nested attribution' });
  await writeFile(path.join(nested, 'index.js'), 'throw new Error("must not execute")');
  const report = await collectNodeLicenses(root, lock);
  assert.equal(report.packageCount, 3);
  assert.deepEqual(report.packages.filter(p => p.name === 'shared').map(p => p.version), ['0.9.0', '1.0.0']);
  assert.ok(Object.values(report.notices).some(n => n.text === 'Nested attribution'));
  assert.equal(report.incompleteEvidenceCount, 0);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('pnpm store and aliases do not omit transitive packages or double count the same install', async t => {
  const { root, lock, add } = await fixture(t);
  const direct = await add('.pnpm/direct@1.0.0/node_modules/direct', 'direct', '1.0.0');
  await add('.pnpm/transitive@2.0.0/node_modules/transitive', 'transitive', '2.0.0');
  await writeFile(path.join(root, 'node_modules', '.pnpm', 'lock.yaml'), 'metadata');
  await symlink(direct, path.join(root, 'node_modules', 'direct'), 'dir');
  const report = await collectNodeLicenses(root, lock);
  assert.equal(report.packageCount, 2);
  assert.equal(Object.keys(report.notices).length, 1);
});

test('missing notices and license metadata remain visible for review', async t => {
  const { root, lock, add } = await fixture(t);
  await add('no-license', 'no-license', '1.0.0', null, {});
  const report = await collectNodeLicenses(root, lock);
  assert.equal(report.incompleteEvidenceCount, 1);
  assert.equal(report.packages[0].declaredLicense, null);
  assert.deepEqual(report.packages[0].noticeFiles, []);
});

test('empty, BOM-only and invisible notices are retained as evidence without closing the gap', async t => {
  const { root, lock, add } = await fixture(t);
  for (const [index, text] of ['', '\uFEFF \r\n\t', '\u200b\u0000'].entries()) {
    await add(`blank-${index}`, `blank-${index}`, '1.0.0', 'MIT', { LICENSE: text });
  }
  const report = await collectNodeLicenses(root, lock);
  assert.equal(report.incompleteEvidenceCount, 3);
  for (const pkg of report.packages) {
    assert.equal(pkg.noticeFiles[0].empty, true);
    assert.equal(report.notices[pkg.noticeFiles[0].sha256].text, ['', '\uFEFF \r\n\t', '\u200b\u0000'][Number(pkg.name.slice(-1))]);
  }
});

test('a reviewed third-party header is supplemental and cannot stand in for the package notice', async t => {
  const { root, lock, add } = await fixture(t);
  const directory = await add('derived', 'derived', '1.0.0', 'MIT', { 'derived.js': '// Third-party copyright and BSD permission\nexport const example = 1;\n' });
  const digest = data => createHash('sha256').update(data).digest('hex');
  const reviewed = [{ name: 'derived', version: '1.0.0', file: 'derived.js', coverage: 'supplemental',
    manifestSha256: digest(await readFile(path.join(directory, 'package.json'))), sha256: digest(await readFile(path.join(directory, 'derived.js'))) }];
  const report = await collectNodeLicenses(root, lock, reviewed);
  assert.equal(report.incompleteEvidenceCount, 1); assert.equal(report.packages[0].noticeFiles[0].coverage, 'supplemental');
  await writeFile(path.join(directory, 'LICENSE'), 'Primary package copyright and full permission');
  assert.equal((await collectNodeLicenses(root, lock, reviewed)).incompleteEvidenceCount, 0);
  const licenseReview = { ...reviewed[0], file: 'LICENSE', sha256: digest(await readFile(path.join(directory, 'LICENSE'))) };
  assert.equal((await collectNodeLicenses(root, lock, [...reviewed, licenseReview])).incompleteEvidenceCount, 1);
  await assert.rejects(collectNodeLicenses(root, lock, [{ ...reviewed[0], coverage: 'complete' }]), /notice coverage/);
});

test('reviewed installed files bind binary bytes without executing them or trusting only a manifest', async t => {
  const { root, lock, add } = await fixture(t);
  const directory = await add('native', 'native', '1.0.0', 'MIT', { LICENSE: 'Full author permission' });
  await mkdir(path.join(directory, 'bin')); const binary = Buffer.from([0x7f, 69, 76, 70, 0, 1, 2]);
  await writeFile(path.join(directory, 'bin', 'tool'), binary);
  const digest = data => createHash('sha256').update(data).digest('hex');
  const source = { name: 'native', version: '1.0.0', file: 'LICENSE',
    manifestSha256: digest(await readFile(path.join(directory, 'package.json'))), sha256: digest('Full author permission'), installedFiles: { 'bin/tool': digest(binary) } };
  const report = await collectNodeLicenses(root, lock, [source]);
  assert.deepEqual(report.packages[0].noticeFiles[0].installedFiles, source.installedFiles);
  assert.equal(Object.values(report.notices).some(notice => notice.text.includes('ELF')), false);
  await writeFile(path.join(directory, 'bin', 'tool'), Buffer.from('changed'));
  await assert.rejects(collectNodeLicenses(root, lock, [source]), /installed file content changed/);
  for (const invalid of ['../LICENSE', '/LICENSE', 'bin//tool', 'C:/secret', 'bin\\tool', 'bin/./tool']) {
    await assert.rejects(collectNodeLicenses(root, lock, [{ ...source, installedFiles: { [invalid]: digest(binary) } }]), /installed file binding/);
  }
  await rm(path.join(directory, 'bin', 'tool'));
  const other = await add('other-native', 'other-native', '1.0.0'); await writeFile(path.join(other, 'tool'), binary);
  await symlink(path.join(other, 'tool'), path.join(directory, 'bin', 'tool'));
  await assert.rejects(collectNodeLicenses(root, lock, [source]), /installed file escapes its package/);
});

function elfHeader() {
  const bytes = Buffer.alloc(64); bytes.set([0x7f, 69, 76, 70, 2, 1, 1]); return bytes;
}
test('inventories recognized ELF, PE and WASM bytes with package-scoped integrity evidence', async t => {
  const { root, lock, add } = await fixture(t);
  const directory = await add('native', 'native', '1.0.0');
  const elf = elfHeader(), wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(80, 60); pe.set([80, 69, 0, 0], 80);
  await mkdir(path.join(directory, 'bin'));
  await writeFile(path.join(directory, 'bin', 'native'), elf); await writeFile(path.join(directory, 'module.wasm'), wasm); await writeFile(path.join(directory, 'addon.node'), pe);
  await writeFile(path.join(directory, 'not-a-binary.node'), 'throw new Error("must not run");');
  await writeFile(path.join(directory, 'truncated-elf'), Buffer.from([0x7f, 69, 76, 70, 2, 1, 1, 0]));
  const nested = await add('native/node_modules/other', 'other', '1.0.0'); await writeFile(path.join(nested, 'other.node'), elf);
  const digest = data => createHash('sha256').update(data).digest('hex');
  const source = { name: 'native', version: '1.0.0', file: 'LICENSE',
    manifestSha256: digest(await readFile(path.join(directory, 'package.json'))), sha256: digest(await readFile(path.join(directory, 'LICENSE'))), installedFiles: { 'bin/native': digest(elf) } };
  const report = await collectNodeLicenses(root, lock, [source]);
  assert.equal(report.binaryFileCount, 4); assert.equal(report.uniqueBinaryCount, 3); assert.equal(report.unboundBinaryFileCount, 3);
  const native = report.packages.find(pkg => pkg.name === 'native');
  assert.deepEqual(native.binaryFiles.map(file => [file.path, file.format, file.reviewedFileBinding]), [['addon.node', 'PE', false], ['bin/native', 'ELF', true], ['module.wasm', 'WASM', false]]);
  assert.equal(native.binaryFiles[1].sha256, digest(elf)); assert.equal(native.binaryFiles[1].bytes, elf.length);
  assert.equal(report.packages.find(pkg => pkg.name === 'other').binaryFiles[0].reviewedFileBinding, false);
  assert.equal(Object.values(report.notices).some(notice => notice.text.includes('\0asm')), false);
  assert.doesNotMatch(JSON.stringify(report), /enersy-licenses-/);
});

test('binary scan terminates same-package directory cycles and refuses cross-package links', async t => {
  const { root, lock, add } = await fixture(t); const directory = await add('native', 'native', '1.0.0');
  await writeFile(path.join(directory, 'addon.node'), elfHeader()); await symlink(directory, path.join(directory, 'cycle'), 'dir');
  assert.equal((await collectNodeLicenses(root, lock)).binaryFileCount, 1);
  const other = await add('other', 'other', '1.0.0'); await writeFile(path.join(other, 'addon.node'), elfHeader());
  await symlink(path.join(other, 'addon.node'), path.join(directory, 'foreign.node'));
  await assert.rejects(collectNodeLicenses(root, lock), /binary scan escapes its package/);
});

test('binary scan rejects oversized recognized payloads before hashing them', async t => {
  const { root, lock, add } = await fixture(t); const directory = await add('native', 'native', '1.0.0');
  const target = path.join(directory, 'large.node'); await writeFile(target, elfHeader());
  const handle = await open(target, 'r+'); try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(collectNodeLicenses(root, lock), /binary exceeds 64 MiB/);
});

test('refuses to copy a notice escaping the installed dependency tree', async t => {
  const { root, lock, add } = await fixture(t);
  const target = await add('escape', 'escape', '1.0.0', 'MIT', {});
  const outside = path.join(root, 'private.txt');
  await writeFile(outside, 'not a dependency notice');
  await symlink(outside, path.join(target, 'LICENSE'));
  await assert.rejects(collectNodeLicenses(root, lock), /escapes node_modules/);
});

test('preserves Unicode attribution, BOM and line endings with a matching byte digest', async t => {
  const { root, lock, add } = await fixture(t);
  const original = '\uFEFFCopyright © Авторы\r\nPermission notice\r\n';
  const target = await add('attribution', 'attribution', '1.0.0', 'MIT', { LICENSE: original });
  await writeFile(path.join(target, 'package.json'), '\uFEFF' + JSON.stringify({ name: 'attribution', version: '1.0.0', license: 'MIT' }));
  const report = await collectNodeLicenses(root, lock);
  const captured = Object.values(report.notices)[0];
  assert.equal(captured.text, original);
  assert.equal(captured.sha256, createHash('sha256').update(original).digest('hex'));
});

test('includes reviewed embedded notices only for the exact package and source bytes', async t => {
  const { root, lock, add } = await fixture(t);
  const text = 'Package instructions\n\nLicense\nCopyright © Authors\nFull permission and disclaimer\n';
  const directory = await add('embedded', 'embedded', '1.0.0', 'MIT', { 'README.md': text });
  const digest = data => createHash('sha256').update(data).digest('hex');
  const reviewed = [{ name: 'embedded', version: '1.0.0', file: 'README.md',
    manifestSha256: digest(await readFile(path.join(directory, 'package.json'))), sha256: digest(text) }];
  assert.equal((await collectNodeLicenses(root, lock)).incompleteEvidenceCount, 1);
  const report = await collectNodeLicenses(root, lock, reviewed);
  assert.equal(report.incompleteEvidenceCount, 0);
  assert.equal(report.packages[0].noticeFiles[0].kind, 'reviewed-embedded');
  assert.equal(report.notices[digest(text)].text, text);
  await writeFile(path.join(directory, 'README.md'), text + 'Changed');
  await assert.rejects(collectNodeLicenses(root, lock, reviewed), /notice content changed/);
  await writeFile(path.join(directory, 'README.md'), text);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'embedded', version: '1.0.0', license: 'ISC' }));
  await assert.rejects(collectNodeLicenses(root, lock, reviewed), /package manifest changed/);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'embedded', version: '1.0.1', license: 'MIT' }));
  assert.equal((await collectNodeLicenses(root, lock, reviewed)).incompleteEvidenceCount, 1);
});

test('reviewed notice source cannot escape its package even within node_modules', async t => {
  const { root, lock, add } = await fixture(t);
  const directory = await add('embedded', 'embedded', '1.0.0', 'MIT', {});
  const other = await add('other', 'other', '1.0.0', 'MIT', { LICENSE: 'Other package copyright' });
  await symlink(path.join(other, 'LICENSE'), path.join(directory, 'README.md'));
  const digest = data => createHash('sha256').update(data).digest('hex');
  const reviewed = [{ name: 'embedded', version: '1.0.0', file: 'README.md',
    manifestSha256: digest(await readFile(path.join(directory, 'package.json'))),
    sha256: digest('Other package copyright') }];
  await assert.rejects(collectNodeLicenses(root, lock, reviewed), /escapes its package/);
  await assert.rejects(collectNodeLicenses(root, lock, [{ ...reviewed[0], file: '../README.md' }]), /Invalid reviewed/);
  await assert.rejects(collectNodeLicenses(root, lock, [...reviewed, ...reviewed]), /Duplicate reviewed/);
});

test('reviewed upstream notices retain exact text and provenance and fail on drift or escape', async t => {
  const { root, lock, add } = await fixture(t);
  const directory = await add('upstream', 'upstream', '1.0.0', 'ISC', {});
  const origin = path.join(root, 'reviewed');
  await mkdir(origin);
  const text = 'Copyright Authors\r\nFull upstream notice\r\n';
  await writeFile(path.join(origin, 'upstream-LICENSE'), text);
  const digest = data => createHash('sha256').update(data).digest('hex');
  const source = { name: 'upstream', version: '1.0.0', file: 'upstream-LICENSE',
    manifestSha256: digest(await readFile(path.join(directory, 'package.json'))), sha256: digest(text),
    kind: 'reviewed-upstream', sourceCommit: 'a'.repeat(40), sourceURL: `https://example.org/${'a'.repeat(40)}/LICENSE` };
  const report = await collectNodeLicenses(root, lock, [source], origin);
  assert.equal(report.incompleteEvidenceCount, 0);
  assert.equal(report.notices[source.sha256].text, text);
  assert.equal(report.packages[0].noticeFiles[0].sourceCommit, source.sourceCommit);
  assert.equal(report.packages[0].noticeFiles[0].kind, 'reviewed-upstream');
  await writeFile(path.join(origin, source.file), 'changed');
  await assert.rejects(collectNodeLicenses(root, lock, [source], origin), /content changed/);
  await writeFile(path.join(origin, source.file), '');
  await assert.rejects(collectNodeLicenses(root, lock, [source], origin), /is empty/);
  await rm(path.join(origin, source.file));
  await writeFile(path.join(root, 'outside'), text);
  await symlink(path.join(root, 'outside'), path.join(origin, source.file));
  await assert.rejects(collectNodeLicenses(root, lock, [source], origin), /escapes its root/);
  await assert.rejects(collectNodeLicenses(root, lock, [{ ...source, sourceURL: 'https://example.org/main/LICENSE' }], origin), /Invalid reviewed upstream/);
  assert.equal((await collectNodeLicenses(root, lock, [{ ...source, version: '2.0.0' }], origin)).incompleteEvidenceCount, 1);
});

test('one release retains both the full upstream license and embedded authorship', async t => {
  const { root, lock, add } = await fixture(t);
  const attribution = 'Library by Original Authors\nLicense: Apache 2.0\n';
  const directory = await add('multiple', 'multiple', '1.0.0', 'Apache-2.0', { 'README.md': attribution });
  const origin = path.join(root, 'reviewed');
  await mkdir(origin);
  const license = 'Full original license text, including its appendix\n';
  await writeFile(path.join(origin, 'multiple-LICENSE'), license);
  const digest = data => createHash('sha256').update(data).digest('hex');
  const manifestSha256 = digest(await readFile(path.join(directory, 'package.json')));
  const embedded = { name: 'multiple', version: '1.0.0', file: 'README.md', manifestSha256, sha256: digest(attribution) };
  const upstream = { ...embedded, file: 'multiple-LICENSE', sha256: digest(license), kind: 'reviewed-upstream',
    sourceCommit: 'b'.repeat(40), sourceURL: `https://example.org/${'b'.repeat(40)}/LICENSE`,
    reason: 'Package-owned code only; native dependencies require separate review.', reviewedUtc: '2026-11-01' };
  const sources = [upstream, embedded];
  const report = await collectNodeLicenses(root, lock, sources, origin);
  assert.equal(report.packageCount, 1);
  assert.equal(report.incompleteEvidenceCount, 0);
  assert.deepEqual(report.packages[0].noticeFiles.map(file => file.kind), ['reviewed-upstream', 'reviewed-embedded']);
  assert.equal(report.packages[0].noticeFiles[0].reviewReason, upstream.reason);
  assert.equal(report.packages[0].noticeFiles[0].reviewedUtc, upstream.reviewedUtc);
  assert.equal('reviewReason' in report.packages[0].noticeFiles[1], false);
  assert.equal(report.notices[digest(license)].text, license);
  assert.equal(report.notices[digest(attribution)].text, attribution);
  await assert.rejects(collectNodeLicenses(root, lock, [...sources, embedded], origin), /Duplicate reviewed/);
  await assert.rejects(collectNodeLicenses(root, lock, [upstream, { ...embedded, manifestSha256: 'c'.repeat(64) }], origin), /Inconsistent reviewed/);
  await writeFile(path.join(directory, 'README.md'), 'Changed author');
  await assert.rejects(collectNodeLicenses(root, lock, sources, origin), /notice content changed/);
  await writeFile(path.join(directory, 'README.md'), attribution);
  await writeFile(path.join(origin, upstream.file), 'Changed license');
  await assert.rejects(collectNodeLicenses(root, lock, sources, origin), /notice content changed/);
});

test('linked author notice is bound to the exact published declaration without network or code execution', async t => {
  const digest = value => createHash('sha256').update(value).digest('hex');
  const { root, lock, add } = await fixture(t);
  const declaredURL = 'http://author.example/mit-license.txt';
  const attribution = `Copyright © Author, 2012–2015\r\n[MIT License](${declaredURL})\r\n`;
  const directory = await add('linked', 'linked', '1.0.0', 'MIT', { 'README.md': attribution });
  await writeFile(path.join(directory, 'index.js'), 'throw new Error("package code must not run")');
  const origin = path.join(root, 'reviewed');
  await mkdir(origin);
  const license = '\ufeffCopyright © Author\r\nFull permission and disclaimer\r\n';
  await writeFile(path.join(origin, 'linked-MIT.txt'), license);
  const source = { name: 'linked', version: '1.0.0', file: 'linked-MIT.txt',
    manifestSha256: digest(await readFile(path.join(directory, 'package.json'))), sha256: digest(license),
    kind: 'reviewed-upstream', sourceCommit: 'a'.repeat(40), sourceURL: `https://example.org/${'a'.repeat(40)}/README.md`,
    linkedNotice: { file: 'README.md', sha256: digest(attribution), declaredURL, retrievedURL: 'https://author.example/mit-license.txt' } };
  const embedded = { name: source.name, version: source.version, manifestSha256: source.manifestSha256,
    file: 'README.md', sha256: digest(attribution) };
  const report = await collectNodeLicenses(root, lock, [source, embedded], origin);
  assert.equal(report.incompleteEvidenceCount, 0);
  assert.equal(report.notices[digest(license)].text, license);
  assert.equal(report.notices[digest(attribution)].text, attribution);
  assert.deepEqual(report.packages[0].noticeFiles[0].linkedNotice, source.linkedNotice);
  await writeFile(path.join(directory, 'README.md'), attribution + 'Changed attribution');
  await assert.rejects(collectNodeLicenses(root, lock, [source], origin), /Linked declaration content changed/);
  await writeFile(path.join(directory, 'README.md'), attribution);
  await assert.rejects(collectNodeLicenses(root, lock, [{ ...source, linkedNotice: { ...source.linkedNotice,
    declaredURL: `${declaredURL}?other`, retrievedURL: 'https://author.example/mit-license.txt?other' } }], origin), /link is absent/);
  await rm(path.join(directory, 'README.md'));
  await assert.rejects(collectNodeLicenses(root, lock, [source], origin), { code: 'ENOENT' });
  const outside = path.join(root, 'private.md');
  await writeFile(outside, attribution);
  await symlink(outside, path.join(directory, 'README.md'));
  await assert.rejects(collectNodeLicenses(root, lock, [source], origin), /escapes/);
});

test('linked notice review refuses changed targets and ambiguous reference metadata', async t => {
  const digest = value => createHash('sha256').update(value).digest('hex');
  const { root, lock, add } = await fixture(t);
  const directory = await add('linked', 'linked', '1.0.0', 'MIT', {});
  const source = { name: 'linked', version: '1.0.0', file: 'MIT.txt',
    manifestSha256: digest(await readFile(path.join(directory, 'package.json'))), sha256: 'b'.repeat(64),
    kind: 'reviewed-upstream', sourceCommit: 'a'.repeat(40), sourceURL: `https://example.org/${'a'.repeat(40)}/README.md`,
    linkedNotice: { file: 'README.md', sha256: 'c'.repeat(64), declaredURL: 'http://author.example/mit.txt', retrievedURL: 'https://author.example/mit.txt' } };
  for (const change of [
    { file: '../README.md' }, { sha256: 'invalid' }, { declaredURL: 'file:///private' },
    { retrievedURL: 'http://author.example/mit.txt' }, { retrievedURL: 'https://other.example/mit.txt' },
    { retrievedURL: 'https://author.example/other.txt' }, { retrievedURL: 'https://user:password@author.example/mit.txt' },
    { retrievedURL: 'https://author.example/mit.txt#fragment' }, { extra: true },
  ]) {
    await assert.rejects(collectNodeLicenses(root, lock, [{ ...source, linkedNotice: { ...source.linkedNotice, ...change } }]), /Invalid linked|changed the author/);
  }
  await assert.rejects(collectNodeLicenses(root, lock, [{ ...source, sourceURL: `https://example.org/${'a'.repeat(40)}/other.md` }]), /Invalid linked/);
  await assert.rejects(collectNodeLicenses(root, lock, [{ ...source, kind: undefined }]), /Invalid linked/);
});
