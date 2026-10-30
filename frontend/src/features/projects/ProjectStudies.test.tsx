// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectStudies } from './ProjectStudies';
import { listStudies, listStudyVersions, readStudy, createStudy, type StudyVersion } from '../../api/studies-api';
import { listStudyRuns } from '../../api/study-runs-api';
import { createStudyIntentJournal } from './study-intent-journal';
import { readStudySnapshot } from './study-snapshot';
import { readProjectScheme, SessionError } from '../../api/projects-api';
vi.mock('../../api/studies-api', async original => ({ ...await original<typeof import('../../api/studies-api')>(), listStudies: vi.fn(), listStudyVersions: vi.fn(), readStudy: vi.fn(), createStudy: vi.fn() }));
vi.mock('./study-snapshot', () => ({ readStudySnapshot: vi.fn() }));
vi.mock('../../api/study-runs-api', async original=>({...await original<typeof import('../../api/study-runs-api')>(),listStudyRuns:vi.fn()}));
vi.mock('../../api/projects-api', async original => ({ ...await original<typeof import('../../api/projects-api')>(), readProjectScheme: vi.fn() }));
const v = (revision = '1'): StudyVersion => ({ status: 'captured', id: '9007199254740994', projectId: '8', schemeId: '7', revision, authorAccountId: '2', topologyRevision: '3', schemeName: 'Удалённый источник', createdAt: '2026-10-25T00:00:00Z', inputSha256: 'a'.repeat(64), provenanceSha256: 'b'.repeat(64), inputBytes: 1, provenanceBytes: 1,
  document: { formatVersion: 1, name: `Версия-${revision}`, modelGroup: 'three-phase', method: 'newton-raphson', computeBackend: 'julia', base: { s_base_mva: 100, v_base_kv: 10 }, solverOptions: { tolerance: 1e-8, max_iterations: 50 }, maxTimeMs: 20000, operatingLimits: [] } });
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const unavailable = vi.fn();
const button = (s: string) => [...host.querySelectorAll('button')].find(b => b.textContent === s)!;
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); root = createRoot(host); vi.mocked(listStudies).mockResolvedValue({ items: [v('2')], next: '' }); vi.mocked(listStudyVersions).mockResolvedValue({ items: [v(), v('2')], next: '' }); vi.mocked(readStudy).mockImplementation(async (_p, _s, _a, r) => v(r)); });
beforeEach(()=>{vi.mocked(listStudyRuns).mockResolvedValue({items:[],next:''});});
afterEach(async () => { await act(async () => root.unmount()); });
const mount = (id = '8', role: 'owner' | 'viewer' = 'viewer') => act(async () => root.render(<ProjectStudies identity={{accountId:'1',sessionId:'2',expiresAt:'2099-01-01T00:00:00Z'}} project={{ id, name: 'Проект', role }} onBack={() => {}} onUnavailable={unavailable} />));
const open = () => act(async () => host.querySelector<HTMLButtonElement>('.study-card')!.click());
test('viewer reads exact historical version and frozen inputs without a live scheme', async () => {
  await mount(); await open();
  await act(async () => button('Версия 1 · Версия-1').click());
  expect(readStudy).toHaveBeenLastCalledWith('8', v().id, expect.any(AbortSignal), '1');
  vi.mocked(readStudySnapshot).mockResolvedValue({ input: { modelGroup: 'three-phase', method: 'newton-raphson', components: [], connections: [] }, provenance: { formatVersion: 1, components: [] } });
  await act(async () => button('Просмотреть сохранённый снимок').click());
  expect(host.textContent).toContain('Снимок версии 1'); expect(readProjectScheme).not.toHaveBeenCalled();
  expect(button('Создать новую версию')).toBeUndefined(); expect(button('Новое исследование')).toBeUndefined();
});
test('viewer sees the unit policy of each selected version without adopting the latest policy', async () => {
  const strict = v('2');
  strict.document.unitContract = { formatVersion: 1, profile: 'legacy-ac-three-phase-rms-v1' };
  vi.mocked(readStudy).mockImplementation(async (_p, _s, _a, revision) => revision === '1' ? v() : strict);
  const displayedPolicy = () => [...host.querySelectorAll('.study-facts dt')].find(dt => dt.textContent === 'Проверка единиц')?.nextElementSibling?.textContent;
  await mount(); await open();
  expect(displayedPolicy()).toBe('Полная декларация · AC v1');
  await act(async () => button('Версия 1 · Версия-1').click());
  expect(displayedPolicy()).toBe('Совместимость с прежними данными');
  expect(readStudy).toHaveBeenLastCalledWith('8', v().id, expect.any(AbortSignal), '1');
  await act(async () => button('Версия 2 · Версия-2').click());
  expect(displayedPolicy()).toBe('Полная декларация · AC v1');
  expect(readProjectScheme).not.toHaveBeenCalled();
  expect(createStudy).not.toHaveBeenCalled();
});
test('deleted live source prevents a new capture but preserves readable history', async () => {
  await mount('8', 'owner'); await open(); vi.mocked(readProjectScheme).mockRejectedValue(new SessionError(404, 'Deleted'));
  await act(async () => button('Создать новую версию').click());
  expect(host.textContent).toContain('Историю и сохранённый снимок можно просматривать');
  expect(host.textContent).toContain('Версия 1 · Версия-1'); expect(unavailable).not.toHaveBeenCalled();
});
test('late snapshot cannot appear after changing project', async () => {
  let resolve!: (v: Awaited<ReturnType<typeof readStudySnapshot>>) => void;
  vi.mocked(readStudySnapshot).mockReturnValue(new Promise(yes => { resolve = yes; }));
  await mount(); await open(); await act(async () => button('Просмотреть сохранённый снимок').click());
  const signal = vi.mocked(readStudySnapshot).mock.calls[0][2];
  vi.mocked(listStudies).mockResolvedValue({ items: [], next: '' });
  await mount('9'); expect(signal.aborted).toBe(true);
  await act(async () => resolve({ input: { modelGroup: 'three-phase', method: 'newton-raphson', components: [], connections: [] }, provenance: { formatVersion: 1, components: [] } }));
  expect(host.textContent).not.toContain('Снимок версии');
});
test('revoked access clears previously visible private data', async () => {
  await act(async () => root.render(<ProjectStudies identity={{accountId:'1',sessionId:'2',expiresAt:'2099-01-01T00:00:00Z'}} project={{ id: '8', name: 'Частное имя проекта', role: 'owner' }} source={{ id: '7', projectId: '8', name: 'Частное имя источника', description: '', topologyRevision: '0', components: [], connections: [] }} onBack={() => {}} onUnavailable={unavailable} />));
  await open(); vi.mocked(listStudies).mockRejectedValue(new SessionError(404, 'Unavailable'));
  await act(async () => button('Обновить исследования').click());
  expect(host.textContent).not.toContain('Удалённый источник'); expect(host.textContent).not.toContain('Версия-2'); expect(unavailable).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain('Частное имя'); expect(button('Новое исследование')).toBeUndefined();
});
test('a late history page cannot repopulate data after access was revoked by another read', async () => {
  let resolve!: (p: { items: StudyVersion[]; next: string }) => void;
  vi.mocked(listStudyVersions).mockReturnValue(new Promise(yes => { resolve = yes; }));
  await mount(); await open();
  vi.mocked(listStudies).mockRejectedValue(new SessionError(404, 'Unavailable'));
  await act(async () => button('Обновить исследования').click());
  await act(async () => resolve({ items: [v()], next: '' }));
  expect(host.textContent).not.toContain('Версия-1'); expect(host.textContent).not.toContain('Удалённый источник');
});
test('remounted project restores pending command without live source or automatic replay, then clears only a confirmed retry', async () => {
  const journal = createStudyIntentJournal({ accountId: '1', sessionId: '2', projectId: '8' });
  const intent = { formatVersion: 1 as const, projectId: '8', schemeId: '7', command: '11111111-1111-4111-8111-111111111111', topology: '3', document: v().document };
  journal.prepare(intent); await mount('8', 'owner');
  expect(host.textContent).toContain('Проверьте прежнее сохранение'); expect(createStudy).not.toHaveBeenCalled(); expect(readProjectScheme).not.toHaveBeenCalled();
  vi.mocked(createStudy).mockRejectedValueOnce(new TypeError('lost confirmation')).mockResolvedValueOnce(v());
  await act(async () => button('Проверить прежнюю команду').click());
  expect(journal.read()).toEqual(intent);
  await act(async () => button('Проверить прежнюю команду').click());
  expect(vi.mocked(createStudy).mock.calls[1].slice(0, 6)).toEqual(vi.mocked(createStudy).mock.calls[0].slice(0, 6));
  expect(journal.read()).toBeNull(); expect(host.textContent).not.toContain('Проверьте прежнее сохранение'); expect(host.textContent).toContain('Версия-1');
});
