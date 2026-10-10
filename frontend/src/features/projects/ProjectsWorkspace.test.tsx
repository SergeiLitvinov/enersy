// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { ProjectsWorkspace } from './ProjectsWorkspace';
import { listProjects, logout, readSession } from '../../api/projects-api';
vi.mock('../../api/projects-api', () => ({ listProjects: vi.fn(), readSession: vi.fn(), logout: vi.fn(), login: vi.fn(), createProject: vi.fn() }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const account = { accountId: '9007199254740993', sessionId: '2', expiresAt: '2026-10-11T00:00:00Z' };
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); root = createRoot(host);
  vi.mocked(readSession).mockResolvedValue(account);
  vi.mocked(listProjects).mockResolvedValue({ items: [{ id: '7', name: 'Private network', role: 'owner' }], nextAfterId: '' });
});
afterEach(async () => { await act(async () => root.unmount()); });
test('logout hides private data before the server reply, even when logout fails', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(logout).mockReturnValue(new Promise((_, no) => { reject = no; }));
  await act(async () => root.render(<ProjectsWorkspace />));
  expect(host.textContent).toContain('Private network');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Выйти')!.click());
  expect(host.textContent).not.toContain('Private network');
  await act(async () => reject(new Error('Network unavailable')));
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Network unavailable');
  expect(host.textContent).not.toContain('Private network');
});
test('focus revalidation clears the old account before showing the new account', async () => {
  await act(async () => root.render(<ProjectsWorkspace />));
  let resolve!: (value: typeof account) => void;
  vi.mocked(readSession).mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  vi.mocked(listProjects).mockResolvedValue({ items: [{ id: '8', name: 'Other account', role: 'viewer' }], nextAfterId: '' });
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(host.textContent).not.toContain('Private network');
  await act(async () => resolve({ ...account, accountId: '9' }));
  expect(host.textContent).toContain('Other account');
  expect(host.textContent).not.toContain('Private network');
});
test('unmount aborts a private read and its late response never triggers a project read', async () => {
  let resolve!: (value: typeof account) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(readSession).mockImplementationOnce(input => { signal = input; return new Promise(yes => { resolve = yes; }); });
  await act(async () => root.render(<ProjectsWorkspace />));
  await act(async () => root.render(<div>Another workspace</div>));
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(account));
  expect(host.textContent).toBe('Another workspace');
  expect(listProjects).not.toHaveBeenCalled();
});
