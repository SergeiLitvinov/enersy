import { afterEach, expect, test, vi } from 'vitest';
import { createStudy, appendStudyVersion, readStudy, listStudies, listStudyVersions, readStudyArtifact, parseStudyDocument, StudyWriteError, type StudyDocument } from './studies-api';
const project = '9007199254740993', study = '9007199254740994', signal = new AbortController().signal, command = '11111111-1111-4111-8111-111111111111';
const document = (): StudyDocument => ({ formatVersion: 1, name: 'AC study', modelGroup: 'three-phase', method: 'newton-raphson', computeBackend: 'julia', maxTimeMs: 20000,
    base: { s_base_mva: 100, v_base_kv: 10 }, solverOptions: { tolerance: 1e-8, max_iterations: 50 }, operatingLimits: [] });
const metadata = () => ({ status: 'captured', id: study, projectId: project, schemeId: '7', revision: '1', authorAccountId: '9007199254740995', topologyRevision: '0',
    schemeName: 'Source', createdAt: '2026-10-24T06:00:00Z', inputSha256: 'a'.repeat(64), provenanceSha256: 'b'.repeat(64), inputBytes: 1, provenanceBytes: 1, document: document() });
const reply = (data: unknown, revision = '1') => new Response(JSON.stringify(data), { headers: { ETag: `"${revision}"` } });
afterEach(() => vi.unstubAllGlobals());

test('compact source digest is sent without a list and ambiguous references never dispatch', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(metadata()));
    vi.stubGlobal('fetch', fetcher);
    const digest = 'v1:' + 'a'.repeat(64);
    await createStudy(project, '7', '0', document(), command, signal, undefined, undefined, digest);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ topologyRevision: '0', document: document(), sourceDigest: digest });
    fetcher.mockClear();
    await expect(createStudy(project, '7', '0', document(), command, signal, undefined, [], digest)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
});

test('expected source revisions reach both writes unchanged; malformed manifests never dispatch', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(metadata()));
    vi.stubGlobal('fetch', fetcher);
    const source = [{ id: '2', revision: '9007199254740993' }];
    await createStudy(project, '7', '0', document(), command, signal, undefined, source);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).sourceRevisions).toEqual(source);
    fetcher.mockResolvedValue(reply({ ...metadata(), revision: '2' }, '2'));
    await appendStudyVersion(project, study, '1', '0', document(), command, signal, undefined, source);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).sourceRevisions).toEqual(source);
    fetcher.mockClear();
    await expect(createStudy(project, '7', '0', document(), command, signal, undefined, [{ id: '2', revision: '0' }])).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
});
test('Study settings require declared units/options and copy caller-owned mutable values', () => {
    const source = document();
    const captured = parseStudyDocument(source);
    source.base.s_base_mva = 200;
    expect(captured.base.s_base_mva).toBe(100);
    for (const bad of [{ ...document(), base: {} }, { ...document(), operatingLimits: null }, { ...document(), computeBackend: 'unknown' }, { ...document(), extra: true }])
        expect(() => parseStudyDocument(bad)).toThrow();
});
test('creation preserves exact scope, source revision and idempotency without credentials in the payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(metadata()));
    vi.stubGlobal('fetch', fetcher);
    expect((await createStudy(project, '7', '0', document(), command, signal)).id).toBe(study);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`/api/projects/${project}/schemes/7/studies`);
    const options = fetcher.mock.calls[0][1];
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'Idempotency-Key': command } });
    expect(JSON.parse(options.body)).toEqual({ topologyRevision: '0', document: document() });
});
test('an explicitly bound command constrains the cookie session through headers, never through identity in its document', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(metadata())); vi.stubGlobal('fetch', fetcher);
    await createStudy(project, '7', '0', document(), command, signal, { accountId: '9007199254740995', sessionId: '9007199254740996' });
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({ 'X-Enersy-Account-Id': '9007199254740995', 'X-Enersy-Session-Id': '9007199254740996' });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ topologyRevision: '0', document: document() });
});
test('acknowledgement cannot substitute another Study document or source scheme', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const changed of [{ ...metadata(), schemeId: '8' }, { ...metadata(), document: { ...document(), maxTimeMs: 5000 } }, { ...metadata(), projectId: '8' }]) {
        fetcher.mockResolvedValue(reply(changed));
        await expect(createStudy(project, '7', '0', document(), command, signal)).rejects.toThrow();
    }
});
test('CAS conflict is returned once and never overwrites or retries caller intent', async () => {
    const source = document();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'study_revision_conflict', error: 'Конфликт' }), { status: 412 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(appendStudyVersion(project, study, '9007199254740993', '0', source, command, signal)).rejects.toMatchObject({ status: 412, code: 'study_revision_conflict' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].headers['If-Match']).toBe('"9007199254740993"');
    expect(source).toEqual(document());
    fetcher.mockResolvedValue(reply({ ...metadata(), revision: '9007199254740994' }, '9007199254740994'));
    expect((await appendStudyVersion(project, study, '9007199254740993', '0', source, command, signal)).revision).toBe('9007199254740994');
});
test('version reads bind identity, revision and ETag without assuming latest means requested', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(metadata()));
    vi.stubGlobal('fetch', fetcher);
    expect((await readStudy(project, study, signal, '1')).revision).toBe('1');
    fetcher.mockResolvedValue(reply({ ...metadata(), revision: '2' }, '2'));
    await expect(readStudy(project, study, signal, '1')).rejects.toThrow();
    fetcher.mockResolvedValue(reply({ ...metadata(), id: '7' }));
    await expect(readStudy(project, study, signal)).rejects.toThrow();
});
test('head and history cursors retain BIGINT identity and reject repeated pages', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [metadata()], nextAfterId: study })));
    vi.stubGlobal('fetch', fetcher);
    expect((await listStudies(project, signal)).next).toBe(study);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ items: [{ ...metadata(), revision: '2' }], nextAfterRevision: '2' })));
    expect((await listStudyVersions(project, study, signal, '1')).next).toBe('2');
    fetcher.mockResolvedValue(new Response(JSON.stringify({ items: [metadata(), metadata()] })));
    await expect(listStudies(project, signal)).rejects.toThrow();
});
test('artifact bytes require exact size, fixed version headers and independently calculated SHA-256', async () => {
    const text = '{"studyReference":{"id":"9007199254740994","revision":"1"}}';
    // Independently computed with .NET SHA256 over the literal UTF-8 bytes above.
    const hash = '8805ec8f533764980f87670c4b14411bb529f113d07db56c7729069f7f01d936';
    const meta = { ...metadata(), inputSha256: hash, inputBytes: new TextEncoder().encode(text).length };
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const responses = (bytes: string, version = '1') => { fetcher.mockReset().mockResolvedValueOnce(reply(meta)).mockResolvedValueOnce(new Response(bytes, { headers: { ETag: `"${hash}"`, 'X-Enersy-Study-Id': study, 'X-Enersy-Study-Revision': version } })); };
    responses(text);
    expect(new TextDecoder().decode(await readStudyArtifact(project, study, '1', 'input', signal))).toBe(text);
    for (const [url, options] of fetcher.mock.calls) {
        expect(url).toContain(`/studies/${study}/versions/1`);
        expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', signal });
    }
    for (const corrupted of [text.slice(0, -1), text + ' ', text.replace('studyReference', 'studyReferencX')]) {
        responses(corrupted);
        await expect(readStudyArtifact(project, study, '1', 'input', signal)).rejects.toThrow();
    }
    responses(text, '2');
    await expect(readStudyArtifact(project, study, '1', 'input', signal)).rejects.toThrow();
});
test('cancelled or revoked access cannot return a partially read Study', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(readStudy(project, study, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(readStudy(project, study, signal)).rejects.toBeInstanceOf(StudyWriteError);
});
