import { afterEach, expect, test, vi } from 'vitest';
import fixtureJSON from '../../../tests/fixtures/editor-draft-v1.json?raw';
import { deleteEditorDraft, EditorDraftError, listEditorDrafts, readEditorDraft, saveEditorDraft } from './editor-drafts-api';
import { parseEditorDraftPayload, type EditorDraftPayload } from './editor-draft-payload';
import { SessionError } from './projects-api';

afterEach(() => vi.unstubAllGlobals());
const fixture: EditorDraftPayload = JSON.parse(fixtureJSON);
const scope = { projectId: '9007199254740993', schemeId: '7' };
const workspaceId = '22222222-2222-4222-8222-222222222222';
const url = '/api/projects/9007199254740993/schemes/7/drafts';
const revision = '9007199254740994';
const meta = { workspaceId, revision, updatedAt: '2026-10-18T10:30:00.123456Z' };
const payload = () => parseEditorDraftPayload(fixture);
const signal = new AbortController().signal;
const reply = (data: unknown, etag = revision, type = 'application/json') => new Response(JSON.stringify(data), {
  headers: { ETag: `"${etag}"`, 'Content-Type': type },
});

test('metadata, reads, PUT and DELETE use only the exact private path with cookies, abort and independent CAS', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ items: [meta] })).mockResolvedValueOnce(reply({ ...meta, payload: fixture }))
    .mockResolvedValueOnce(reply(meta)).mockResolvedValueOnce(reply(meta));
  vi.stubGlobal('fetch', fetcher);
  expect(await listEditorDrafts(scope, signal)).toEqual([meta]);
  expect(await readEditorDraft(scope, workspaceId, signal)).toEqual({ ...meta, payload: fixture });
  await saveEditorDraft(scope, workspaceId, '9007199254740993', payload(), signal);
  await deleteEditorDraft(scope, workspaceId, '9007199254740993', signal);
  expect(fetcher.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
    [url, 'GET'], [`${url}/${workspaceId}`, 'GET'], [`${url}/${workspaceId}`, 'PUT'], [`${url}/${workspaceId}`, 'DELETE'],
  ]);
  for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
  expect(fetcher.mock.calls[2][1].headers).toMatchObject({ 'If-Match': '"9007199254740993"', 'Content-Type': 'application/json' });
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual(fixture);
  expect(fetcher.mock.calls[3][1].body).toBeUndefined();
});
test('only explicit revision zero creates a new journal; deletion never invents zero', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ ...meta, revision: '1' }, '1'));
  vi.stubGlobal('fetch', fetcher);
  expect(await saveEditorDraft(scope, workspaceId, '0', payload(), signal)).toMatchObject({ revision: '1' });
  expect(fetcher.mock.calls[0][1].headers['If-Match']).toBe('"0"');
  await expect(deleteEditorDraft(scope, workspaceId, '0', signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('mismatched identity/ETag, imprecise revisions and nonconsecutive acknowledgements cannot confirm a save', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const override of [{ workspaceId: '33333333-3333-4333-8333-333333333333' }, { revision: 4 },
    { revision: '9223372036854775808' }, { updatedAt: 'yesterday' }, { revision: '9007199254740995' }]) {
    const data = { ...meta, ...override };
    fetcher.mockResolvedValue(reply(data, String(data.revision)));
    await expect(saveEditorDraft(scope, workspaceId, '9007199254740993', payload(), signal)).rejects.toThrow();
  }
  fetcher.mockResolvedValue(reply(meta, '1'));
  await expect(saveEditorDraft(scope, workspaceId, '9007199254740993', payload(), signal)).rejects.toThrow('контекст');
  fetcher.mockResolvedValue(reply({ ...meta, payload: { ...fixture, formatVersion: 2 } }));
  await expect(readEditorDraft(scope, workspaceId, signal)).rejects.toThrow('журнал');
});
test('metadata listing rejects duplicate contexts, private payloads and over-limit lists', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const items of [null, [meta, meta], [{ ...meta, payload: fixture }], Array.from({ length: 33 }, () => meta)]) {
    fetcher.mockResolvedValue(reply({ items }));
    await expect(listEditorDrafts(scope, signal)).rejects.toThrow();
  }
});
test('permission failures, conflicts, quotas and lost replies never retry, delete or fall back to a shared API', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const status of [401, 404, 409, 412, 413, 428, 503]) {
    fetcher.mockResolvedValue(new Response('PRIVATE BODY MUST NOT REACH UI', { status }));
    const error = await saveEditorDraft(scope, workspaceId, '9007199254740993', payload(), signal).catch(error => error);
    expect(error).toBeInstanceOf(EditorDraftError);
    expect(error).toBeInstanceOf(SessionError);
    expect(error.status).toBe(status); expect(error.message).not.toContain('PRIVATE');
    if (status === 412) expect(error.code).toBe('editor_draft_revision_conflict');
  }
  fetcher.mockRejectedValue(new TypeError('lost acknowledgement'));
  await expect(saveEditorDraft(scope, workspaceId, '9007199254740993', payload(), signal)).rejects.toThrow('lost acknowledgement');
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(fetcher.mock.calls.every(([path, options]) => path === `${url}/${workspaceId}` && options.method === 'PUT')).toBe(true);
});
test('invalid scopes, UUIDs, CAS, oversized or damaged local payloads are rejected before dispatch', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const scope of [{ projectId: '../1', schemeId: '7' }, { projectId: '9223372036854775808', schemeId: '7' },
    { projectId: '1', schemeId: '2147483648' }]) {
    await expect(readEditorDraft(scope, workspaceId, signal)).rejects.toThrow();
  }
  for (const expected of ['01', '-1', '9223372036854775807']) await expect(saveEditorDraft(scope, workspaceId, expected, payload(), signal)).rejects.toThrow();
  await expect(readEditorDraft(scope, workspaceId.toUpperCase().replace('2', 'A'), signal)).rejects.toThrow();
  const large = payload();
  large.components[0].base.params = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), 'x'.repeat(16384)]));
  await expect(saveEditorDraft(scope, workspaceId, '0', large, signal)).rejects.toThrow('256');
  expect(fetcher).not.toHaveBeenCalled();
});
test('abort before dispatch, during response headers and during body read never publishes stale data', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const first = new AbortController(); first.abort();
  await expect(readEditorDraft(scope, workspaceId, first.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  const second = new AbortController();
  fetcher.mockImplementation(async () => { second.abort(); return reply({ ...meta, payload: fixture }); });
  await expect(readEditorDraft(scope, workspaceId, second.signal)).rejects.toThrow();
  const third = new AbortController();
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...meta, payload: fixture }))); third.abort(); }, cancel,
  }, { highWaterMark: 0 });
  fetcher.mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
  await expect(readEditorDraft(scope, workspaceId, third.signal)).rejects.toThrow();
  expect(cancel).toHaveBeenCalled();
});
test('response byte limit is enforced without Content-Length and stops the stream', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'application/json' } })));
  await expect(listEditorDrafts(scope, signal)).rejects.toThrow('слишком велик');
  expect(cancel).toHaveBeenCalled();
});
test('HTML, malformed JSON and invalid UTF-8 cannot become a journal', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const response of [reply(meta, revision, 'text/html'), new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } })]) {
    fetcher.mockResolvedValue(response);
    await expect(readEditorDraft(scope, workspaceId, signal)).rejects.toThrow();
  }
});
