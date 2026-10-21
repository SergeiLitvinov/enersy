import { afterEach, expect, test, vi } from 'vitest';
import { listProjectPassports, parsePassportVersion, readProjectPassport, saveProjectPassport, type PassportAttempt } from './project-passports-api';
import { SessionError } from './projects-api';
const document = { formatVersion: 1 as const, componentTypeCode: 'generator', name: 'Source', manufacturer: 'Factory', source: 'User data', license: 'Author declaration', parameters: { power_nom: { value: '10.00', unit: 'МВА' } } };
const version = { id: '1', projectId: '8', authorAccountId: '2', predecessorId: null, revision: 1, status: 'draft', sha256: 'a'.repeat(64), createdAt: '2026-10-20T12:00:00Z', document };
const attempt: PassportAttempt = { commandId: 'aaaaaaaa-0000-4000-8000-000000000001', predecessorId: null, document };
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
test('page validates project membership, ordering and cursor and uses private transport', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [version], nextAfterId: '1' })));
  vi.stubGlobal('fetch', fetcher);
  const page = await listProjectPassports('8', signal()); expect(page.items[0].document.parameters.power_nom.value).toBe('10.00');
  expect(fetcher).toHaveBeenCalledWith('/api/projects/8/passports?limit=20', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  fetcher.mockResolvedValue(new Response(JSON.stringify({ items: [version, version] })));
  await expect(listProjectPassports('8', signal())).rejects.toThrow();
  fetcher.mockResolvedValue(new Response(JSON.stringify({ items: [version], nextAfterId: '2' })));
  await expect(listProjectPassports('8', signal())).rejects.toThrow();
});
test.each([{ projectId: '9' }, { id: '9223372036854775808' }, { predecessorId: '1' }, { status: 'published' }, { sha256: 'broken' }])('rejects malformed or foreign version %j', patch => {
  expect(() => parsePassportVersion({ ...version, ...patch }, '8')).toThrow();
});
test('save sends the frozen command and rejects a changed acknowledgement', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(version))); vi.stubGlobal('fetch', fetcher);
  await saveProjectPassport('8', attempt, signal());
  const init = fetcher.mock.calls[0][1]; expect(init.headers['Idempotency-Key']).toBe(attempt.commandId);
  expect(JSON.parse(init.body)).toEqual({ predecessorId: null, document });
  fetcher.mockResolvedValue(new Response(JSON.stringify({ ...version, document: { ...document, name: 'Changed' } })));
  await expect(saveProjectPassport('8', attempt, signal())).rejects.toThrow();
});
test('wrong version identity, revocation and cancellation do not return a passport', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(version))); vi.stubGlobal('fetch', fetcher);
  await expect(readProjectPassport('8', '2', signal())).rejects.toThrow();
  fetcher.mockResolvedValue(new Response('{}', { status: 404 }));
  await expect(listProjectPassports('8', signal())).rejects.toBeInstanceOf(SessionError);
  const controller = new AbortController();
  fetcher.mockImplementation(async () => { controller.abort(); return new Response(JSON.stringify(version)); });
  await expect(readProjectPassport('8', '1', controller.signal)).rejects.toThrow();
});
