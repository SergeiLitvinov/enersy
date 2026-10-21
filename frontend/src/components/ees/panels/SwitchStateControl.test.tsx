// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ComponentParams } from './ComponentParams';
import { ComponentSVG } from '../svg-components';
import type { EditorComponent } from '../editor-utils';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const save = vi.fn<(key: string, value: string) => Promise<void>>();
const equipment: EditorComponent = { id: 7, type: 'breaker', typeId: 1, revision: '1', name: 'Q1', x: 0, y: 0, rotation: 0, params: { status: 'false' } };
async function render(component = equipment) {
  const Symbol = ComponentSVG[component.type];
  await act(async () => root.render(<><svg><Symbol params={component.params} /></svg><ComponentParams key={component.id} component={component} onSave={save} /></>));
}
const button = (name: string) => [...host.querySelectorAll('button')].find(item => item.textContent === name)!;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  save.mockReset(); save.mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

test('position can be saved without a loaded parameter template; blade follows confirmed data', async () => {
  let acknowledge!: () => void;
  save.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
  await render();
  const blade = host.querySelector('[data-contact="blade"]')!.getAttribute('d');
  await act(async () => button('Замкнут').click());
  expect(save).toHaveBeenCalledExactlyOnceWith('status', 'true');
  expect(button('Замкнут').disabled).toBe(true);
  expect(button('Разомкнут').disabled).toBe(true);
  expect(host.querySelector('[data-switch-position]')?.getAttribute('data-switch-position')).toBe('open');
  await act(async () => acknowledge());
  await render({ ...equipment, params: { status: 'true' }, revision: '2' });
  expect(host.querySelector('[data-switch-position]')?.getAttribute('data-switch-position')).toBe('closed');
  expect(host.querySelector('[data-contact="blade"]')!.getAttribute('d')).not.toBe(blade);
  expect(button('Замкнут').getAttribute('aria-pressed')).toBe('true');
});
test('a failed save preserves the confirmed position and permits a retry', async () => {
  save.mockRejectedValueOnce(new Error('Конфликт ревизии'));
  await render(); await act(async () => button('Замкнут').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Конфликт ревизии');
  expect(host.querySelector('[data-switch-position]')?.getAttribute('data-switch-position')).toBe('open');
  expect(button('Замкнут').disabled).toBe(false);
});
test('unknown status draws no false contact position and can be explicitly corrected', async () => {
  await render({ ...equipment, type: 'disconnector', params: { status: '?' }, paramTemplate: [{ key: 'status', name: 'Статус', type: 'boolean', default: 'true', unit: '' }] });
  expect(host.querySelector('[data-contact="blade"]')).toBeNull();
  expect(host.querySelector('svg text')?.textContent).toBe('?');
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  await act(async () => button('Разомкнут').click());
  expect(save).toHaveBeenCalledExactlyOnceWith('status', 'false');
});
test('missing earthing-switch position does not silently inherit the breaker default', async () => {
  await render({ ...equipment, type: 'grounding_switch', params: {} });
  expect(host.querySelector('[data-switch-position]')?.getAttribute('data-switch-position')).toBe('unknown');
  expect(host.textContent).toContain('расчёт заземляющего аппарата пока не поддержан');
  expect(save).not.toHaveBeenCalled();
});
test('an implicit closed default can be explicitly recorded without opening first', async () => {
  await render({ ...equipment, params: {} });
  expect(host.textContent).toContain('допущение текущего ядра');
  expect(button('Замкнут').disabled).toBe(false);
  await act(async () => button('Замкнут').click());
  expect(save).toHaveBeenCalledExactlyOnceWith('status', 'true');
});
