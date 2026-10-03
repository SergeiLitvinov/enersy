// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useCanvasInteraction } from './useCanvasInteraction';
import type { EditorComponent } from '../editor-utils';

const first: EditorComponent = { id: 1, type: 'busbar', typeId: 11, revision: '1', name: 'Bus', x: 100, y: 100, rotation: 0, params: {} };
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let state: ReturnType<typeof useCanvasInteraction>;
let components: EditorComponent[];
let replace: React.Dispatch<React.SetStateAction<EditorComponent[]>>;
let projectionOffset: number;
const move = vi.fn();
const connect = vi.fn();
const select = vi.fn();
function Harness({ schemeId = 1 }: { schemeId?: number }) {
  const [items, setItems] = useState([first, { ...first, id: 2, x: 400 }]);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1600, h: 1000 });
  const ref = useRef<HTMLDivElement>(null);
  components = items; replace = setItems;
  state = useCanvasInteraction({ components: items, setComponents: setItems, connections: [],
    screenToWorld: (x, y) => ({ x: x + projectionOffset, y }), getWorldUnitsPerPixel: () => 1, setViewBox, viewBox, containerRef: ref,
    currentSchemeId: schemeId, onMoveEnd: move, onConnectEnd: connect, onSelectComponent: select, onSelectConnection: () => {} });
  return <div ref={ref} onMouseDown={state.handleMouseDown} onMouseMove={state.handleMouseMove}
    onMouseUp={state.handleMouseUp} onMouseLeave={state.resetInteraction} />;
}
function dispatch(type: string, x: number, y: number, buttons = type === 'mouseup' ? 0 : 1) {
  container.firstElementChild!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons }));
}
async function event(type: string, x: number, y: number, buttons?: number) { await act(async () => dispatch(type, x, y, buttons)); }
beforeEach(async () => {
  vi.resetAllMocks(); projectionOffset = 0; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); });

test('selection and subpixel jitter do not change geometry or dispatch a write, even after viewport reflow', async () => {
  await event('mousedown', 160, 115);
  projectionOffset = 50;
  await event('mousemove', 161, 115); await event('mouseup', 161, 115);
  expect(select).toHaveBeenCalledWith(1);
  expect(components[0]).toMatchObject({ x: 100, y: 100 }); expect(move).not.toHaveBeenCalled();
});

test('final mouseup coordinates are saved once even when intermediate React state has not rendered', async () => {
  await act(async () => { dispatch('mousedown', 160, 115); dispatch('mousemove', 170, 125); dispatch('mouseup', 180, 135); dispatch('mouseup', 180, 135); });
  expect(components[0]).toMatchObject({ x: 120, y: 120 });
  expect(move).toHaveBeenCalledExactlyOnceWith(1, 120, 120);
});

test('cancel restores the unsaved position and preserves independently changed fields', async () => {
  await event('mousedown', 160, 115); await event('mousemove', 180, 135);
  await act(async () => replace(previous => previous.map(item => item.id === 1 ? { ...item, revision: '2', params: { u: '220' } } : item)));
  await act(async () => state.resetInteraction());
  expect(components[0]).toMatchObject({ x: 100, y: 100, revision: '2', params: { u: '220' } });
  expect(move).not.toHaveBeenCalled(); expect(state.dragMode).toBeNull();
});

test('lost mouseup cancels on movement with released buttons and cannot produce ghost movement', async () => {
  await event('mousedown', 160, 115); await event('mousemove', 180, 135);
  await event('mousemove', 190, 140, 0); await event('mousemove', 200, 150, 0); await event('mouseup', 200, 150);
  expect(components[0]).toMatchObject({ x: 100, y: 100 }); expect(move).not.toHaveBeenCalled();
});

test('an in-flight connection cannot be duplicated or clear a newer gesture when it completes', async () => {
  let finish!: () => void;
  connect.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  await event('mousedown', 100, 115); await event('mouseup', 400, 115); await event('mouseup', 400, 115);
  expect(connect).toHaveBeenCalledExactlyOnceWith(1, 1, 2, 'left', 'left');
  await event('mousedown', 160, 115);
  await act(async () => finish());
  expect(state.dragMode).toBe('move');
  await event('mouseup', 180, 135);
  expect(move).toHaveBeenCalledExactlyOnceWith(1, 120, 120);
});

test('a drag returned to its original position does not dispatch a write', async () => {
  await event('mousedown', 160, 115); await event('mousemove', 180, 135); await event('mouseup', 160, 115);
  expect(components[0]).toMatchObject({ x: 100, y: 100 }); expect(move).not.toHaveBeenCalled();
});

test('an old gesture cannot restore geometry into a different scheme or complete a connection there', async () => {
  await event('mousedown', 160, 115); await event('mousemove', 180, 135);
  await act(async () => { root.render(<Harness schemeId={2} />); });
  await act(async () => replace([{ ...first, x: 900, y: 900 }]));
  await event('mouseup', 180, 135);
  expect(components[0]).toMatchObject({ x: 900, y: 900 }); expect(move).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
});
