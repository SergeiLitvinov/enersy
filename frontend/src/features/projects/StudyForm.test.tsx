// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StudyForm } from './StudyForm';
import { createStudyIntentJournal } from './study-intent-journal';
import { createStudy, appendStudyVersion, readStudy, StudyWriteError, type StudyVersion } from '../../api/studies-api';
import type { ProjectGraph } from './project-graph';
vi.mock('../../api/studies-api', async original => ({ ...await original<typeof import('../../api/studies-api')>(), createStudy: vi.fn(), appendStudyVersion: vi.fn(), readStudy: vi.fn() }));
const graph: ProjectGraph = { id: '7', projectId: '8', name: 'Сеть', description: '', topologyRevision: '3', components: [], connections: [] };
const version = (): StudyVersion => ({ status: 'captured', id: '9007199254740994', projectId: '8', schemeId: '7', revision: '1', authorAccountId: '2', topologyRevision: '3', schemeName: 'Сеть', createdAt: '2026-10-25T00:00:00Z', inputSha256: 'a'.repeat(64), provenanceSha256: 'b'.repeat(64), inputBytes: 1, provenanceBytes: 1,
  document: { formatVersion: 1, name: 'Исследование', modelGroup: 'three-phase', method: 'newton-raphson', computeBackend: 'julia', base: { s_base_mva: 100, v_base_kv: 10 }, solverOptions: { tolerance: 1e-8, max_iterations: 50 }, maxTimeMs: 20000, operatingLimits: [] } });
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const saved = vi.fn(), close = vi.fn();
const button = (s: string) => [...host.querySelectorAll('button')].find(b => b.textContent === s)!;
const input = (label: string) => [...host.querySelectorAll('label')].find(l => l.textContent === label)!.querySelector('input')!;
async function change(label: string, value: string) { await act(async () => { const field = input(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }); }
beforeEach(() => { vi.resetAllMocks(); window.sessionStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const mount = async (v?: StudyVersion, role: 'owner' | 'viewer' = 'owner') => act(async () => root.render(<StudyForm journal={createStudyIntentJournal({accountId:'1',sessionId:'2',projectId:'8'})} project={{ id: '8', name: 'Проект', role }} source={graph} version={v} onSaved={saved} onClose={close} />));
test('new Study requires explicit physical bases and does not invent network parameters', async () => {
  await mount(); expect(button('Сохранить снимок').disabled).toBe(true);
  await change('Название', 'Проверка'); await change('Базис мощности, МВА', '100'); await change('Базис напряжения, кВ', '10');
  vi.mocked(createStudy).mockResolvedValue(version());
  await act(async () => button('Сохранить снимок').click());
  expect(createStudy).toHaveBeenCalledOnce(); expect(createStudy).toHaveBeenCalledWith('8', '7', '3', expect.objectContaining({ name: 'Проверка', base: { s_base_mva: 100, v_base_kv: 10 } }), expect.any(String), expect.any(AbortSignal), {accountId:'1',sessionId:'2',projectId:'8'});
  expect(saved).toHaveBeenCalledOnce();
});
test('uncertain save freezes intent and retries the same command and document', async () => {
  await mount(version()); await change('Название', 'Мой черновик');
  vi.mocked(appendStudyVersion).mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce({ ...version(), revision: '2' });
  await act(async () => button('Сохранить снимок').click());
  expect(input('Название').closest('fieldset')!.disabled).toBe(true); expect(close).not.toHaveBeenCalled();
  expect(createStudyIntentJournal({ accountId: '1', sessionId: '2', projectId: '8' }).read()?.document.name).toBe('Мой черновик');
  await act(async () => button('Повторить ту же команду').click());
  const calls = vi.mocked(appendStudyVersion).mock.calls;
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(saved).toHaveBeenCalledOnce();
  expect(createStudyIntentJournal({ accountId: '1', sessionId: '2', projectId: '8' }).read()).toBeNull();
});
test('CAS conflict preserves local settings; adopting latest revision requires a separate save', async () => {
  await mount(version()); await change('Название', 'Мой черновик');
  vi.mocked(appendStudyVersion).mockRejectedValueOnce(new StudyWriteError(412, 'Conflict', 'study_revision_conflict')).mockResolvedValueOnce({ ...version(), revision: '4' });
  vi.mocked(readStudy).mockResolvedValue({ ...version(), revision: '3', document: { ...version().document, name: 'Чужие настройки' } });
  await act(async () => button('Сохранить снимок').click());
  expect(appendStudyVersion).toHaveBeenCalledOnce(); expect(input('Название').value).toBe('Мой черновик');
  await act(async () => button('Сравнить с актуальной версией').click());
  expect(host.textContent).toContain('Чужие настройки'); expect(input('Название').value).toBe('Мой черновик');
  await act(async () => button('Продолжить с моими настройками после версии 3').click());
  expect(appendStudyVersion).toHaveBeenCalledOnce();
  await act(async () => button('Сохранить снимок').click());
  expect(vi.mocked(appendStudyVersion).mock.calls[1].slice(0, 5)).toEqual(['8', version().id, '3', '3', expect.objectContaining({ name: 'Мой черновик' })]);
  expect(vi.mocked(appendStudyVersion).mock.calls[1][5]).not.toBe(vi.mocked(appendStudyVersion).mock.calls[0][5]);
});
test('viewer cannot dispatch a write even if the form is mounted directly', async () => {
  await mount(version(), 'viewer'); await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(appendStudyVersion).not.toHaveBeenCalled(); expect(createStudy).not.toHaveBeenCalled();
});
test('failure to persist intent blocks dispatch before any request is made', async () => {
  await act(async () => root.render(<StudyForm journal={createStudyIntentJournal({ accountId: '1', sessionId: '2', projectId: '8' }, () => { throw new Error('storage blocked'); })} project={{ id: '8', name: 'P', role: 'owner' }} source={graph} version={version()} onSaved={saved} onClose={close} />));
  await act(async () => button('Сохранить снимок').click());
  expect(appendStudyVersion).not.toHaveBeenCalled(); expect(host.textContent).toContain('Запрос не отправлен');
});
