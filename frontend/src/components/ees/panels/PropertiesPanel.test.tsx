// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PropertiesPanel } from './PropertiesPanel';
import type { EditorComponent } from '../editor-utils';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const component: EditorComponent = { id: 1, revision: '1', typeId: 1, type: 'generator', name: 'G', x: 0, y: 0, rotation: 0, params: { p: '100' }, paramTemplate: [{ key: 'p', name: 'Power', type: 'number', unit: 'MW', default: '' }] };
const next = { ...component, id: 2, name: 'L', type: 'transmission_line' };
const save = vi.fn();
async function render(selected = component) { await act(async () => root.render(<PropertiesPanel selectedComponent={selected} selectedConnection={null} onSaveParam={save} components={[component, next]} connections={[]} />)); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); save.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
test('switching inspector section retains unsaved text and sends no parameter writes', async () => {
  await render(); const input = host.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const buttons = host.querySelectorAll<HTMLButtonElement>('.inspector-sections button');
  await act(async () => buttons[1].click()); expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  await act(async () => buttons[0].click()); expect(host.querySelector('input')).toBe(input); expect(input.value).toBe('123'); expect(save).not.toHaveBeenCalled();
});
test('equipment navigation keeps terminal view while replacing object identity and terminal count', async () => {
  await render(); await act(async () => host.querySelectorAll<HTMLButtonElement>('.inspector-sections button')[1].click());
  await render(next); expect(host.querySelectorAll('.terminal-card')).toHaveLength(2); expect(host.querySelector('.param-title:not(.component-params .param-title)')?.textContent).toBe('L #2');
  expect(host.querySelectorAll('.inspector-sections button')[1].getAttribute('aria-pressed')).toBe('true');
});
