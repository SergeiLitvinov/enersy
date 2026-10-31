// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LoadProfileForm } from './LoadProfileForm';

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const save = vi.fn<(values: Readonly<Record<string, string>>) => Promise<void>>();
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
  save.mockResolvedValue(); await act(async () => submit());
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toMatchObject({ p: '10', q: '3', voltage_nom: '10', zip_enabled: 'true', zip_p_z: '0', zip_p_i: '0', zip_p_p: '1', zip_q_p: '1' });
  expect(host.textContent).toContain('Профиль сохранён');
});

test('prevents repeated same-batch submit and retains values when saving fails', async () => {
  await render(); await input('p', '12');
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
