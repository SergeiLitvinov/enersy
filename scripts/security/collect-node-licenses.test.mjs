import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
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
