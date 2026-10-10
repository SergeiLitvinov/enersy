import { afterEach, expect, test, vi } from 'vitest';
import { listProjects, readProject, readSession, login, logout } from './projects-api';
afterEach(() => vi.unstubAllGlobals());
const signal = new AbortController().signal;
test('selected project is read independently of pagination with exact scoped ID', async () => {
  const project = { id: '9007199254740993', name: 'Selected', role: 'editor' };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(project)));
  vi.stubGlobal('fetch', fetcher);
  expect(await readProject(project.id, signal)).toEqual(project);
  expect(fetcher).toHaveBeenCalledWith('/api/projects/9007199254740993', expect.objectContaining({ method: 'GET', signal, cache: 'no-store', credentials: 'same-origin' }));
});
test('project detail rejects foreign replies, invalid IDs and revoked access without fallback', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: '8', name: 'Wrong parent', role: 'owner' })))
    .mockResolvedValueOnce(new Response('{}', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(readProject('7', signal)).rejects.toThrow('другому проекту');
  await expect(readProject('7', signal)).rejects.toMatchObject({ status: 404 });
  await expect(readProject('9223372036854775808', signal)).rejects.toThrow('ID проекта');
  const controller = new AbortController(); controller.abort();
  await expect(readProject('7', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test('empty project page and exact BIGINT session IDs follow the real server contract', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accountId: '9007199254740993', sessionId: '9007199254740994', expiresAt: '2026-10-11T00:00:00Z' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }))));
  expect((await readSession(signal))?.accountId).toBe('9007199254740993');
  expect(await listProjects(signal)).toEqual({ items: [], nextAfterId: '' });
});
test('lost sessions resolve anonymous and expired logout is idempotent', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
  expect(await readSession(signal)).toBeNull();
  await expect(logout(false, signal)).resolves.toBeUndefined();
});
test('untrusted identities and project role values cannot enter UI state', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accountId: 9007199254740992, sessionId: '1', expiresAt: '2026-10-11' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: '7', name: 'Invalid', role: 'superuser' }] }))));
  await expect(readSession(signal)).rejects.toThrow('Некорректная сессия');
  await expect(listProjects(signal)).rejects.toThrow('Некорректная карточка');
});
test('login uses same-origin cookies, disables caching, and never includes secrets in URL', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(login('operator', 'secret', signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal,
    body: JSON.stringify({ login: 'operator', password: 'secret' }) }));
});
