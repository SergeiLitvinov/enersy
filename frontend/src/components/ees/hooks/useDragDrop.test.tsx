// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useDragDrop } from './useDragDrop';

const mime = 'application/x-enersy-equipment-type+json';
const item = { id: 1, code: 'generator', name: 'Генератор', category: 'source', description: '' };
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const add = vi.fn();
const error = vi.fn();
const project = vi.fn((x: number, y: number) => ({ x: x * 2, y: y * 2 }));
function Harness({ enabled = true, library = [item] }) {
  const handlers = useDragDrop({ addComponent: add, screenToWorld: project, library, enabled, onError: error });
  return <div onDrop={handlers.handleCanvasDrop} onDragOver={handlers.handleDragOver}
    onDragStart={e => handlers.handleLibDragStart(e, item)} />;
}
function transfer(value: string, types = [mime, 'application/json']) {
  return { types, files: [], effectAllowed: 'none', dropEffect: 'none', getData: () => value, setData: vi.fn() };
}
async function dispatch(type: string, dataTransfer: ReturnType<typeof transfer>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer, clientX: 20, clientY: 30 });
  await act(async () => { container.firstElementChild!.dispatchEvent(event); });
  return event;
}
beforeEach(async () => {
  vi.clearAllMocks(); add.mockResolvedValue(undefined);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); });

test.each(['null', '[]', '{',
  JSON.stringify({ version: 1, typeId: 999, code: 'generator' }),
  JSON.stringify({ version: 1, typeId: 1, code: 'transformer' }),
  JSON.stringify({ version: 2, typeId: 1, code: 'generator' }),
  JSON.stringify({ version: 1, typeId: '1', code: 'generator' }),
])('invalid drop %s cannot open an equipment dialog', async value => {
  await dispatch('drop', transfer(value));
  expect(add).not.toHaveBeenCalled(); expect(project).not.toHaveBeenCalled();
});

test('non-finite placement and oversized packets are rejected before adding equipment', async () => {
  const data = transfer(JSON.stringify({ version: 1, typeId: 1, code: 'generator' }));
  project.mockReturnValueOnce({ x: Infinity, y: 0 });
  await dispatch('drop', data);
  await dispatch('drop', transfer(' '.repeat(4097)));
  expect(add).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledTimes(2);
});

test('foreign generic JSON is ignored and not advertised as a supported drag', async () => {
  const data = transfer(JSON.stringify(item), ['application/json']);
  const over = await dispatch('dragover', data);
  expect(over.defaultPrevented).toBe(false);
  await dispatch('drop', data);
  expect(add).not.toHaveBeenCalled();
});

test('valid drag resolves the current catalog item, not transferred names or metadata', async () => {
  await dispatch('drop', transfer(JSON.stringify({ version: 1, typeId: 1, code: 'generator', name: 'Чужое имя' })));
  expect(add).toHaveBeenCalledExactlyOnceWith(item, 40, 60);
  expect(error).not.toHaveBeenCalled();
});

test('disabled or removed catalog types cannot be dropped', async () => {
  const data = transfer(JSON.stringify({ version: 1, typeId: 1, code: 'generator' }));
  await act(async () => root.render(<Harness enabled={false} />));
  await dispatch('drop', data); expect(add).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness library={[]} />));
  await dispatch('drop', data); expect(add).not.toHaveBeenCalled();
});

test('drag start emits a versioned type reference; add failures are reported', async () => {
  const data = transfer('');
  await dispatch('dragstart', data);
  expect(data.setData).toHaveBeenCalledExactlyOnceWith(mime, JSON.stringify({ version: 1, typeId: 1, code: 'generator' }));
  add.mockRejectedValueOnce(new Error('unavailable'));
  await dispatch('drop', transfer(JSON.stringify({ version: 1, typeId: 1, code: 'generator' })));
  expect(error).toHaveBeenCalledTimes(1);
});
