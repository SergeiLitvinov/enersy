// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ParameterUnitDialog } from './ParameterUnitDialog';
import type { EditorComponent } from '../editor-utils';

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
