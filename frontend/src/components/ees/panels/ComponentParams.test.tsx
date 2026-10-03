// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EditorComponent } from '../editor-utils';
import { ComponentParams } from './ComponentParams';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const save = vi.fn();
const component: EditorComponent = { id: 1, type: 'busbar', typeId: 1, revision: '1', name: 'Bus', x: 0, y: 0, rotation: 0,
  params: { u: '110', i: '2000', enabled: 'true' },
  paramTemplate: ['u', 'i', 'enabled'].map(key => ({ key, name: key, type: key === 'enabled' ? 'boolean' : 'number', default: '', unit: '' })) };
const input = (key: string) => container.querySelector<HTMLInputElement>(`#param-1-${key}`)!;
async function render(params = component.params, resets?: Record<string, number>) {
  await act(async () => root.render(<ComponentParams component={{ ...component, params }} onSave={save} parameterResets={resets} />));
}
async function type(key: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(key), value);
    input(key).dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => { save.mockReset(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('accepting a reviewed field displays the server value and cannot resubmit the rejected value on blur', async () => {
  await render(); await type('u', '750');
  await render({ ...component.params, u: '500' }, { u: 1 });
  expect(input('u').value).toBe('500');
  await act(async () => { input('u').focus(); input('u').blur(); });
  expect(save).not.toHaveBeenCalled();
});

test('partial review resets only selected fields, including acceptance of an unchanged server value', async () => {
  await render(); await type('u', '750'); await type('i', '3000');
  const current = input('i'); current.focus();
  await render(component.params, { u: 1 });
  expect(input('u').value).toBe('110'); expect(input('i').value).toBe('3000');
  expect(input('i')).toBe(current); expect(document.activeElement).toBe(current);
});

test('ordinary acknowledgements preserve focus and newer typing while clean fields follow confirmed data', async () => {
  await render(); await type('u', '220'); const current = input('u'); current.focus();
  await render({ ...component.params, u: '220', i: '2500', enabled: 'false' });
  expect(input('u')).toBe(current); expect(document.activeElement).toBe(current);
  expect(input('i').value).toBe('2500'); expect(input('enabled').checked).toBe(false);
  await type('u', '330');
  await render({ ...component.params, u: '250' });
  expect(input('u').value).toBe('330');
});

test('explicit acceptance also resets boolean input and clears a removed server parameter', async () => {
  await render(); await type('u', '750');
  await act(async () => input('enabled').click());
  await render({ i: '2000', enabled: 'true' }, { u: 1, enabled: 1 });
  expect(input('u').value).toBe(''); expect(input('enabled').checked).toBe(true);
});
