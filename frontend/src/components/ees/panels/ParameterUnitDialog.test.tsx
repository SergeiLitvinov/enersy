// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ParameterUnitDialog } from './ParameterUnitDialog';
import type { EditorComponent } from '../editor-utils';
import { ParameterFormDraftContext, type ParameterFormDraftStore } from './parameter-form-draft-context';
import { createParameterFormDraftJournal } from '../../../features/projects/parameter-form-draft-journal';

vi.mock('../../ui/Dialog', () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const component: EditorComponent = { id: 7, revision: '1', typeId: 1, type: 'generator', name: 'Generator', x: 0, y: 0, rotation: 0,
  params: { p: '10' }, paramTemplate: [{ key: 'p', name: 'Активная мощность', type: 'number', unit: 'МВт', default: '999' }] };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const save = vi.fn(), close = vi.fn();
beforeEach(() => { vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const inputs = () => host.querySelectorAll<HTMLInputElement>('input');
const submit = () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
async function type(index: number, value: string) { await act(async () => { const input = inputs()[index]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
const render = async (value = component) => { await act(async () => root.render(<ParameterUnitDialog component={value} onSave={save} onClose={close} />)); };

test('p.u. needs explicit source bases and preserves them after a rejected write', async () => {
  save.mockRejectedValueOnce(new Error('Revision conflict'));
  await render(); await type(1, 'p.u.');
  expect(inputs()[2].value).toBe(''); expect(inputs()[3].value).toBe('');
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  await type(2, '10'); await type(3, '35');
  await act(async () => submit());
  expect(save).toHaveBeenCalledWith('p', '10', 'p.u.', { profile: 'ac-three-phase-rms-v1', s_base_mva: 10, v_base_kv: 35 });
  expect(close).not.toHaveBeenCalled();
  expect(inputs()[2].value).toBe('10'); expect(inputs()[3].value).toBe('35');
  expect(host.textContent).toContain('Revision conflict');
});

test('saved source bases are displayed without using a template or Study base', async () => {
  await render({ ...component, declaredParameterUnits: { formatVersion: 2, units: { p: 'p.u.' }, bases: { p: { profile: 'ac-three-phase-rms-v1', s_base_mva: 20, v_base_kv: 110 } } } });
  expect(inputs()[2].value).toBe('20'); expect(inputs()[3].value).toBe('110');
  await type(1, 'MW'); expect(inputs()).toHaveLength(2);
  await act(async () => submit());
  expect(save).toHaveBeenCalledWith('p', '10', 'MW');
});

test('current template is a hint and never becomes an implicit declaration or default value', async () => {
  await render();
  expect(inputs()[0].value).toBe('10'); expect(inputs()[1].value).toBe(''); expect(inputs()[1].placeholder).toBe('МВт');
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  await type(1, 'Вт'); await type(0, '10000000'); save.mockResolvedValue(undefined);
  await act(async () => submit());
  expect(save).toHaveBeenCalledWith('p', '10000000', 'Вт'); expect(close).toHaveBeenCalledOnce();
});

test('saved declaration overrides hint and errors preserve the exact new value/unit pair', async () => {
  await render({ ...component, declaredParameterUnits: { formatVersion: 1, units: { p: 'MW' } } });
  expect(inputs()[1].value).toBe('MW');
  await type(0, '10.0000'); await type(1, 'W'); save.mockRejectedValue(new Error('Revision conflict'));
  await act(async () => submit());
  expect(inputs()[0].value).toBe('10.0000'); expect(inputs()[1].value).toBe('W'); expect(close).not.toHaveBeenCalled();
  expect(host.querySelector('[role=alert]')?.textContent).toBe('Revision conflict');
});

test('new server revision prevents a stale form submission even with unchanged numeric strings', async () => {
  await render(); await type(1, 'МВт');
  await render({ ...component, revision: '2', declaredParameterUnits: { formatVersion: 1, units: { p: 'Вт' } } });
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('изменилось');
});

test('same-batch duplicate submit sends one value/unit operation', async () => {
  await render(); await type(1, 'МВт');
  let resolve!: () => void; save.mockReturnValue(new Promise<void>(yes => { resolve = yes; }));
  await act(async () => { submit(); submit(); }); expect(save).toHaveBeenCalledOnce();
  expect(host.querySelector('fieldset')?.disabled).toBe(true);
  await act(async () => resolve()); expect(close).toHaveBeenCalledOnce();
});

const openJournal = () => createParameterFormDraftJournal({ accountId: '1', sessionId: '2', projectId: '3', schemeId: '4' }, new AbortController().signal);
async function renderStored(store: ParameterFormDraftStore, value = component) {
  await act(async () => root.render(<ParameterFormDraftContext.Provider value={store}><ParameterUnitDialog component={value} onSave={save} onClose={close} /></ParameterFormDraftContext.Provider>));
}
async function remount() { await act(async () => root.unmount()); root = createRoot(host); }
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === text)!.click()); }

test('restores incomplete bases only after explicit choice, then saves once and clears', async () => {
  sessionStorage.clear(); const store = openJournal(); await renderStored(store); await type(1, 'p.u.'); await type(0, '0.25000'); await type(2, '20e-');
  expect(store.read(7)?.draft.power).toBe('20e-'); await remount(); await renderStored(openJournal());
  await act(async () => submit()); expect(save).not.toHaveBeenCalled(); expect(host.querySelector('fieldset')!.disabled).toBe(true);
  await click('Восстановить ввод параметра'); expect(inputs()[0].value).toBe('0.25000'); expect(inputs()[2].value).toBe('20e-');
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  await type(2, '20'); await type(3, '110'); save.mockResolvedValue(undefined); await act(async () => submit());
  expect(save).toHaveBeenCalledOnce(); expect(store.read(7)).toBeNull(); expect(close).toHaveBeenCalledOnce();
});

test('historical revision and basis remain visible and block replay after reopening', async () => {
  sessionStorage.clear(); const store = openJournal();
  const based = { ...component, declaredParameterUnits: { formatVersion: 2 as const, units: { p: 'p.u.' }, bases: { p: { profile: 'ac-three-phase-rms-v1' as const, s_base_mva: 10, v_base_kv: 110 } } } };
  await renderStored(store, based); await type(0, '0.25000'); await remount();
  const changed = { ...based, revision: '2', declaredParameterUnits: { ...based.declaredParameterUnits, bases: { p: { ...based.declaredParameterUnits.bases.p, s_base_mva: 20 } } } };
  await renderStored(openJournal(), changed); await click('Восстановить ввод параметра'); await act(async () => submit());
  expect(save).not.toHaveBeenCalled(); expect(host.textContent).toContain('Sб 10 МВА'); expect(store.read(7)?.sourceRevision).toBe('1');
  expect(host.textContent).toContain('Актуальное: 10 · p.u. · Sб 20 МВА');
  await click('Вернуть актуальное значение'); expect(store.read(7)).toBeNull(); expect(inputs()[2].value).toBe('20');
  await type(0, '0.12500'); await act(async () => submit()); expect(save).toHaveBeenCalledWith('p', '0.12500', 'p.u.', expect.objectContaining({ s_base_mva: 20 }));
});

test('changing the selected parameter cannot silently replace dirty input', async () => {
  sessionStorage.clear(); const store = openJournal(); await renderStored(store, { ...component, params: { p: '10', q: '3' } }); await type(1, 'МВт');
  await act(async () => { const select = host.querySelector('select')!; select.value = 'q'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(store.read(7)?.draft.key).toBe('p'); expect(host.querySelector('select')!.value).toBe('p');
  expect(host.textContent).toContain('Сначала сохраните'); await click('Отмена'); expect(store.read(7)).toBeNull();
});

test('failed raw storage blocks network writes and keeps text visible', async () => {
  await renderStored({ read: () => null, save: () => { throw new Error('quota'); } }); await type(1, 'МВт'); await type(0, '12.0000');
  await act(async () => submit()); expect(save).not.toHaveBeenCalled(); expect(inputs()[0].value).toBe('12.0000'); expect(host.textContent).toContain('запись на сервер заблокирована');
});

test('cleanup failure after commit never permits a second server write', async () => {
  const journal = openJournal(); sessionStorage.clear(); let failCleanup = false;
  const store: ParameterFormDraftStore = { read: id => journal.read(id), save: (id, value) => { if (failCleanup && value === null) throw new Error('cleanup'); journal.save(id, value); } };
  await renderStored(store); await type(1, 'МВт'); save.mockImplementation(async () => { failCleanup = true; });
  await act(async () => submit()); expect(save).toHaveBeenCalledOnce(); expect(host.textContent).toContain('сохранены на сервере');
  await act(async () => submit()); expect(save).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  failCleanup = false; await click('Закрыть сохранённую форму'); expect(journal.read(7)).toBeNull(); expect(close).toHaveBeenCalledOnce();
});
