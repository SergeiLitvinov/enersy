import { afterEach, expect, test, vi } from 'vitest';
import { listProjects, readSession, login, logout } from './projects-api';
afterEach(() => vi.unstubAllGlobals());
const signal = new AbortController().signal;
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
