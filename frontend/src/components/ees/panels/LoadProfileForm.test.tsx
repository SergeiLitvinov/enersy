// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LoadProfileForm } from './LoadProfileForm';
import { loadProfileUnits } from '../../../domain/load-profile';
import type { ParameterUnitDeclaration } from '../../../api/parameter-unit-declaration';
import { LoadFormDraftContext, type LoadFormDraftStore } from './load-form-draft-context';
import { createLoadFormDraftJournal } from '../../../features/projects/load-form-draft-journal';

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const save = vi.fn<(values: Readonly<Record<string, string>>, declaration: ParameterUnitDeclaration) => Promise<void>>();
const initial = { p: '10', q: '3', voltage_nom: '10' };
test('the load editor displays declared labels without converting numeric strings', async () => {
  await act(async () => root.render(<LoadProfileForm componentId={5} params={initial} onSave={save} unitDeclaration={{ formatVersion: 1, units: { p: 'MW', voltage_nom: 'kV' } }} />));
  expect(host.querySelector('label[for="load-5-p"] small')?.textContent).toBe('MW');
  expect(host.querySelector<HTMLInputElement>('#load-5-p')?.value).toBe('10');
  expect(save).not.toHaveBeenCalled();
});

test('a unit-only update blocks dirty load profile text until explicit restoration', async () => {
  await act(async () => root.render(<LoadProfileForm componentId={5} params={initial} onSave={save} unitDeclaration={{ formatVersion: 1, units: { p: 'МВт' } }} />));
  await input('p', '12');
  await act(async () => root.render(<LoadProfileForm componentId={5} params={initial} onSave={save} unitDeclaration={{ formatVersion: 1, units: { p: 'Вт' } }} />));
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('#load-5-p')?.value).toBe('12');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('единицы');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Вернуть сохранённый')!.click());
  expect(host.querySelector<HTMLInputElement>('#load-5-p')?.value).toBe('10');
  expect(host.querySelector('[role=alert]')).toBeNull();
});
const render = async (params = initial, resets: Record<string, number> = {}) => { await act(async () => root.render(<LoadProfileForm componentId={5} params={params} onSave={save} parameterResets={resets} />)); };
async function input(id: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(`#load-5-${id}`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function mode(value: string) {
  const el = host.querySelector('select')!;
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function acknowledge() { await act(async () => host.querySelector<HTMLInputElement>('#load-5-units')!.click()); }
const submit = () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); save.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

test('does not autosave or invent ZIP fractions and submits one complete profile', async () => {
  await render(); await mode('zip');
  expect(save).not.toHaveBeenCalled();
  expect(host.querySelectorAll('.load-fractions input')).toHaveLength(6);
  expect([...host.querySelectorAll<HTMLInputElement>('.load-fractions input')].every(el => el.value === '')).toBe(true);
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  for (const el of host.querySelectorAll<HTMLInputElement>('.load-fractions input')) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, el.getAttribute('aria-label')!.includes('мощность') ? '1' : '0'); el.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  await acknowledge(); save.mockResolvedValue(); await act(async () => submit());
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toMatchObject({ p: '10', q: '3', voltage_nom: '10', zip_enabled: 'true', zip_p_z: '0', zip_p_i: '0', zip_p_p: '1', zip_q_p: '1' });
  expect(host.textContent).toContain('Профиль сохранён');
});

test('prevents repeated same-batch submit and retains values when saving fails', async () => {
  await render(); await input('p', '12'); await acknowledge();
  let reject!: (error: Error) => void;
  save.mockReturnValue(new Promise<void>((_, no) => { reject = no; }));
  await act(async () => { submit(); submit(); }); expect(save).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Конфликт ревизии')));
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('12');
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('Конфликт ревизии');
});

test('external updates preserve dirty text, block overwrite and allow explicit restoration', async () => {
  await render(); await input('p', '12'); await render({ ...initial, p: '11', q: '4' });
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('12');
  expect(host.querySelector<HTMLInputElement>('#load-5-q')!.value).toBe('4');
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll('button')].find(el => el.textContent === 'Вернуть сохранённый')!.click());
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('11');
});

test('review resets only the accepted fields of a local form', async () => {
  await render(); await input('p', '12'); await input('q', '6');
  await render(initial, { p: 1 });
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('10');
  expect(host.querySelector<HTMLInputElement>('#load-5-q')!.value).toBe('6');
});


test('no profile writes without an explicit declaration; declaring units preserves exact numeric strings', async () => {
  await render(); await input('p', '12.0000');
  expect(host.querySelector('label[for="load-5-p"] small')?.textContent).toBe('Единица не задана');
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  await acknowledge();
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('12.0000');
  await act(async () => submit());
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0]).toMatchObject({ p: '12.0000', zip_enabled: 'false', zip_p_z: '' });
  expect(save.mock.calls[0][1]).toEqual({ formatVersion: 1, units: { p: 'МВт', q: 'Мвар', voltage_nom: 'кВ', zip_enabled: '1', zip_p_z: '1', zip_p_i: '1', zip_p_p: '1', zip_q_z: '1', zip_q_i: '1', zip_q_p: '1' } });
  expect(host.querySelector<HTMLInputElement>('#load-5-units')!.checked).toBe(false);
});

test('a new declaration is an explicit relabelling, with a warning and no automatic scale conversion', async () => {
  await act(async () => root.render(<LoadProfileForm componentId={5} params={initial} onSave={save} unitDeclaration={{ formatVersion: 1, units: { p: 'W', q: 'Mvar', voltage_nom: 'kV' } }} />));
  expect(host.querySelector('label[for="load-5-p"] small')?.textContent).toBe('W');
  await acknowledge();
  expect(host.querySelector('label[for="load-5-p"] small')?.textContent).toBe('МВт');
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('10');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('не пересчитывает');
  await acknowledge(); await act(async () => submit()); expect(save).not.toHaveBeenCalled();
});

test('a successful value/unit acknowledgement does not conflict with its own unit changes', async () => {
  await render(); await input('p', '12.0000'); await acknowledge();
  await act(async () => submit());
  const patch = save.mock.calls[0][0];
  await act(async () => root.render(<LoadProfileForm componentId={5} params={patch} onSave={save} unitDeclaration={{ formatVersion: 1, units: { ...loadProfileUnits } }} />));
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('12.0000');
  expect(host.querySelector<HTMLInputElement>('#load-5-units')!.checked).toBe(false);
  await input('p', '13.0000');
  await act(async () => root.render(<LoadProfileForm componentId={5} params={patch} onSave={save} unitDeclaration={{ formatVersion: 1, units: { ...loadProfileUnits } }} parameterResets={{ q: 1 }} />));
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('13.0000');
});

test('server unit changes invalidate an already acknowledged declaration even before numeric edits', async () => {
  await render(); await acknowledge();
  await act(async () => root.render(<LoadProfileForm componentId={5} params={initial} onSave={save} unitDeclaration={{ formatVersion: 1, units: { p: 'W' } }} />));
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  expect(host.querySelector('[role=alert]')?.textContent).toBeTruthy();
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Вернуть сохранённый')!.click());
  expect(host.querySelector<HTMLInputElement>('#load-5-units')!.checked).toBe(false);
  expect(host.querySelector('label[for="load-5-p"] small')?.textContent).toBe('W');
});


test('a no-op acknowledgement cannot erase newer text during a later unrelated review reset', async () => {
  const params = { ...initial, zip_enabled: 'false', zip_p_z: '', zip_p_i: '', zip_p_p: '', zip_q_z: '', zip_q_i: '', zip_q_p: '' };
  const declaration = { formatVersion: 1 as const, units: { ...loadProfileUnits } };
  await act(async () => root.render(<LoadProfileForm componentId={5} params={params} onSave={save} unitDeclaration={declaration} />));
  await acknowledge(); await act(async () => submit()); expect(save).toHaveBeenCalledOnce();
  await input('p', '12.0000');
  await act(async () => root.render(<LoadProfileForm componentId={5} params={params} onSave={save} unitDeclaration={declaration} parameterResets={{ q: 1 }} />));
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('12.0000');
});

const basedParams = { ...initial, p: '0.1000', q: '0.0300', voltage_nom: '1.0000' };
const basedDeclaration = (power = 100): ParameterUnitDeclaration => ({ formatVersion: 2,
  units: { ...loadProfileUnits, p: 'p.u.', q: 'p.u.', voltage_nom: 'p.u.' },
  bases: Object.fromEntries(['p', 'q', 'voltage_nom'].map(key => [key, { profile: 'ac-three-phase-rms-v1', s_base_mva: power, v_base_kv: 10 }])) });
async function representation(value: string) {
  const select = host.querySelector<HTMLSelectElement>('#load-5-representation')!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function renderBased(declaration = basedDeclaration(), params = basedParams) {
  await act(async () => root.render(<LoadProfileForm componentId={5} params={params} onSave={save} unitDeclaration={declaration} />));
}

test('saved representation preserves exact coefficients and independently captured source bases', async () => {
  const declaration = basedDeclaration();
  declaration.bases!.q!.s_base_mva = 200;
  declaration.bases!.voltage_nom!.v_base_kv = 35;
  await renderBased(declaration); await representation('saved'); await input('p', '0.12500'); await acknowledge();
  expect(host.textContent).toContain('Sб 100 МВА');
  expect(host.querySelector('label[for="load-5-p"] small')?.textContent).toBe('p.u.');
  await act(async () => submit());
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0]).toMatchObject({ p: '0.12500', q: '0.0300', voltage_nom: '1.0000' });
  expect(save.mock.calls[0][1]).toEqual(declaration);
  expect(save.mock.calls[0][1].bases!.p).not.toBe(declaration.bases!.p);
  await renderBased(declaration, { ...basedParams, ...save.mock.calls[0][0] });
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('#load-5-units')!.checked).toBe(false);
});

test.each([false, true])('basis-only changes block stale load edits (acknowledged: %s)', async acknowledged => {
  await renderBased(); await representation('saved'); await input('p', '0.12500');
  if (acknowledged) await acknowledge();
  await renderBased(basedDeclaration(200));
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('0.12500');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('базисы изменились');
  if (!acknowledged) await acknowledge();
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Вернуть сохранённый')!.click());
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('0.1000');
  await acknowledge(); await act(async () => submit());
  expect(save.mock.calls[0][1].bases!.p?.s_base_mva).toBe(200);
});

test('basis-only changes also invalidate canonical relabelling acknowledged without numeric edits', async () => {
  await renderBased(); await acknowledge(); await renderBased(basedDeclaration(200));
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain('базисы изменились');
});

test('saved p.u. cannot be submitted with a missing basis, and changing policy consumes consent', async () => {
  await renderBased({ formatVersion: 1, units: { ...loadProfileUnits, p: 'p.u.' } });
  await representation('saved'); await acknowledge(); await act(async () => submit());
  expect(save).not.toHaveBeenCalled(); expect(host.textContent).toContain('сначала задайте исходные');
  await representation('canonical');
  expect(host.querySelector<HTMLInputElement>('#load-5-units')!.checked).toBe(false);
  await acknowledge(); await act(async () => submit());
  expect(save.mock.calls[0][1]).toEqual({ formatVersion: 1, units: { ...loadProfileUnits } });
});

test('an in-place basis update is detected even though values and unit labels are unchanged', async () => {
  const declaration = basedDeclaration(); await renderBased(declaration); await representation('saved'); await input('p', '0.2');
  declaration.bases!.p!.s_base_mva = 300;
  await renderBased(declaration); await acknowledge(); await act(async () => submit());
  expect(save).not.toHaveBeenCalled(); expect(host.textContent).toContain('базисы изменились');
});

const journal = () => createLoadFormDraftJournal({ accountId: '1', sessionId: '2', projectId: '3', schemeId: '4' }, new AbortController().signal);
async function renderStored(store: LoadFormDraftStore, declaration = basedDeclaration(), params = { ...initial, p: '0.1000' }) {
  await act(async () => root.render(<LoadFormDraftContext.Provider value={store}><LoadProfileForm componentId={5} params={params} onSave={save} unitDeclaration={declaration} /></LoadFormDraftContext.Provider>));
}
async function remount() { await act(async () => root.unmount()); root = createRoot(host); }
async function clickText(text: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === text)!.click()); }

test('unapplied incomplete text survives remount, requires explicit restoration and new consent', async () => {
  sessionStorage.clear(); const store = journal(); await renderStored(store);
  await representation('saved'); await input('p', '0.25000e-'); await acknowledge();
  expect(store.read(5)?.draft.p).toBe('0.25000e-'); expect(save).not.toHaveBeenCalled();
  await remount(); await renderStored(journal());
  expect(host.textContent).toContain('есть неприменённый ввод');
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('0.1000');
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  await clickText('Восстановить ввод');
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('0.25000e-');
  expect(host.querySelector<HTMLInputElement>('#load-5-units')!.checked).toBe(false);
  await input('p', '0.25000'); await acknowledge(); save.mockResolvedValue(); await act(async () => submit());
  expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0][0].p).toBe('0.25000');
  expect(save.mock.calls[0][1].bases!.p?.s_base_mva).toBe(100);
});

test('reopened text never adopts a new server basis and can be explicitly discarded', async () => {
  sessionStorage.clear(); const store = journal(); await renderStored(store);
  await representation('saved'); await input('p', '0.25000');
  await remount(); await renderStored(journal(), basedDeclaration(200)); await clickText('Восстановить ввод'); await acknowledge();
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain('базисы изменились');
  expect(host.querySelector('details')!.textContent).toContain('100 МВА');
  expect(store.read(5)!.declaration!.bases!.p?.s_base_mva).toBe(100);
  await clickText('Вернуть сохранённый'); expect(store.read(5)).toBeNull();
  expect(host.querySelector<HTMLInputElement>('#load-5-units')!.checked).toBe(false);
  await remount(); await renderStored(journal(), basedDeclaration(200));
  expect(host.textContent).not.toContain('есть неприменённый ввод');
});

test('storage failure preserves visible text and blocks submitting an undurable profile', async () => {
  const store = { read: () => null, save: vi.fn(() => { throw new Error('quota'); }) };
  await renderStored(store); await input('p', '0.25000'); await acknowledge(); await act(async () => submit());
  expect(save).not.toHaveBeenCalled(); expect(host.textContent).toContain('Ввод формы не сохранён');
  expect(host.querySelector<HTMLInputElement>('#load-5-p')!.value).toBe('0.25000');
});

test('a confirmed save clears the raw form journal without replaying on reopen', async () => {
  sessionStorage.clear(); const store = journal(); await renderStored(store); await representation('saved');
  await input('p', '0.25000'); await acknowledge(); save.mockResolvedValue(); await act(async () => submit());
  const patch = save.mock.calls[0][0];
  await renderStored(store, save.mock.calls[0][1], { ...initial, ...patch });
  expect(store.read(5)).toBeNull();
  await remount(); await renderStored(journal(), save.mock.calls[0][1], { ...initial, ...patch });
  expect(host.textContent).not.toContain('есть неприменённый ввод'); expect(save).toHaveBeenCalledOnce();
});

test('an external live conflict does not rewrite the historical basis in the raw journal', async () => {
  sessionStorage.clear(); const store = journal(); await renderStored(store); await representation('saved'); await input('p', '0.25000');
  await renderStored(store, basedDeclaration(200));
  expect(store.read(5)!.declaration!.bases!.p?.s_base_mva).toBe(100);
  await remount(); await renderStored(journal(), basedDeclaration(200)); await clickText('Восстановить ввод'); await acknowledge();
  await act(async () => submit()); expect(save).not.toHaveBeenCalled(); expect(host.querySelector('details')!.textContent).toContain('100 МВА');
});

test('damaged storage is not overwritten until the user explicitly discards it', async () => {
  sessionStorage.clear(); const store = journal(); await renderStored(store); await input('p', '0.25000');
  const key = sessionStorage.key(0)!; sessionStorage.setItem(key, 'broken');
  await remount(); await renderStored(journal());
  expect(host.textContent).toContain('Не удалось прочитать'); expect(sessionStorage.getItem(key)).toBe('broken');
  await act(async () => submit()); expect(save).not.toHaveBeenCalled();
  await clickText('Отбросить локальный ввод'); expect(store.read(5)).toBeNull();
  expect(host.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false);
});
