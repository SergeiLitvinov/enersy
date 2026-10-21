import { afterEach, expect, test, vi } from 'vitest';
import { listCalculationArchives, readCalculationArchive, parseArchiveMetadata, parseArchiveInput } from './calculation-archives-api';
const input = { components: [{ id: 1, type: 'load', x: 0, y: 0, rotation: 0, params: { p: '10' } }], connections: [], modelGroup: 'three-phase', method: 'newton-raphson' };
const result = { success: true, node_count: 1, iterations: 1, computation_time_ms: 1, method_used: 'three-phase/newton-raphson', nodes: [{ node_id: 1, node_type: 'pq', voltage: 10, angle: 0, phase: 10, quadrature: 0 }] };
const inputText = JSON.stringify(input), resultText = JSON.stringify(result);
const metadata = { id: '9007199254740993', schemeId: '7', schemeName: 'Исходная схема', authorAccountId: '9007199254740994', topologyRevision: '0', modelGroup: input.modelGroup, method: input.method, createdAt: '2026-10-19T12:00:00Z', inputSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), inputBytes: new TextEncoder().encode(inputText).length, resultBytes: new TextEncoder().encode(resultText).length };
afterEach(() => vi.unstubAllGlobals());
test('loads optional audit evidence by its own exact size, archive identity and digest', async () => {
  const provenance = { formatVersion: 1, components: [{ id:'1', revision:'2', name:'Нагрузка', source:'instance' }] };
  const text = JSON.stringify(provenance), updated = { ...metadata, provenanceSha256:'c'.repeat(64), provenanceBytes:new TextEncoder().encode(text).length };
  const original = responses();
  const fetcher = vi.fn(async (url: string) => url.endsWith('/provenance') ? new Response(text,{headers:{ETag:`"${updated.provenanceSha256}"`,'X-Enersy-Archive-Id':metadata.id}}) :
    url.endsWith('/input') || url.endsWith('/result') ? original(url) : new Response(JSON.stringify(updated)));
  vi.stubGlobal('fetch',fetcher);
  expect((await readCalculationArchive('8',metadata.id,new AbortController().signal)).provenance).toEqual(provenance);
  expect(fetcher.mock.calls).toHaveLength(4);
  expect(() => parseArchiveMetadata({ ...metadata, provenanceSha256:'c'.repeat(64) })).toThrow();
  expect(() => parseArchiveMetadata({ ...updated, provenanceBytes:0 })).toThrow();
});
function responses(patch: { headers?: Record<string, string>; input?: string; result?: string } = {}) {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/input') || url.endsWith('/result')) { const kind = url.endsWith('/input') ? 'input' : 'result';
      return new Response(patch[kind] ?? (kind === 'input' ? inputText : resultText), { headers: { ETag: `"${kind === 'input' ? metadata.inputSha256 : metadata.resultSha256}"`, 'X-Enersy-Archive-Id': metadata.id, ...patch.headers } }); }
    return new Response(JSON.stringify(metadata));
  }); vi.stubGlobal('fetch', fetcher); return fetcher;
}
test('loads exact scoped archive bodies with cancellation, cache isolation and bigint IDs', async () => {
  const f = responses(), signal = new AbortController().signal;
  const value = await readCalculationArchive('8', metadata.id, signal);
  expect(value.input.components[0].params.p).toBe('10'); expect(value.result).toEqual(result); expect(value.metadata.id).toBe(metadata.id);
  expect(f).toHaveBeenCalledTimes(3);
  for (const [url, options] of f.mock.calls as unknown as [string, RequestInit][]) { expect(url).toContain('/api/projects/8/calculation-archives/'); expect(options).toMatchObject({ signal, cache: 'no-store', credentials: 'same-origin' }); }
});
test.each<{ headers?: Record<string, string>; input?: string; result?: string }>([{ headers: { ETag: '"wrong"' } }, { headers: { 'X-Enersy-Archive-Id': '2' } }, { input: inputText + ' ' }, { result: resultText.slice(0, -1) }])('rejects mismatched body provenance or byte size %j', async patch => {
  responses(patch); await expect(readCalculationArchive('8', metadata.id, new AbortController().signal)).rejects.toThrow('архив');
});
test('validates input equipment identity, references and saved method', () => {
  for (const value of [{ ...input, method: 'other' }, { ...input, components: [...input.components, ...input.components] }, { ...input, connections: [{ from: 1, to: 2, fromPort: 'top', toPort: 'left' }] }, { ...input, components: [{ ...input.components[0], params: { p: 10 } }] }]) expect(() => parseArchiveInput(value, metadata)).toThrow();
  for (const patch of [{ id: '9223372036854775808' }, { inputBytes: 0 }, { topologyRevision: '-1' }, { createdAt: 'yesterday' }, { resultSha256: [] }]) expect(() => parseArchiveMetadata({ ...metadata, ...patch })).toThrow();
});
test('requires descending unique page IDs and a cursor matching the last item', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [metadata], nextBeforeId: metadata.id }))));
  expect((await listCalculationArchives('8', new AbortController().signal)).nextBeforeId).toBe(metadata.id);
  for (const data of [{ items: [metadata, metadata] }, { items: [metadata], nextBeforeId: '3' }]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data)))); await expect(listCalculationArchives('8', new AbortController().signal)).rejects.toThrow();
  }
});
test('revocation and cancellation never return a partially opened archive', async () => {
  const c = new AbortController(); c.abort(); responses(); await expect(readCalculationArchive('8', metadata.id, c.signal)).rejects.toThrow();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
  await expect(readCalculationArchive('8', metadata.id, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
});
