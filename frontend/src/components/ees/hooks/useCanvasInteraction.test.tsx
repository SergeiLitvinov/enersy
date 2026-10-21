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
let unitsPerPixel: number;
const move = vi.fn();
const connect = vi.fn();
const select = vi.fn();
const selectConnection = vi.fn();
function Harness({ schemeId = 1, wire = false }: { schemeId?: number; wire?: boolean }) {
  const [items, setItems] = useState([first, { ...first, id: 2, x: 400 }]);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1600, h: 1000 });
  const ref = useRef<HTMLDivElement>(null);
  components = items; replace = setItems;
  state = useCanvasInteraction({ components: items, setComponents: setItems, connections: wire ? [{id:9,from:2,to:1,fromPort:'right',toPort:'left'}] : [],
    screenToWorld: (x, y) => ({ x: x*unitsPerPixel + projectionOffset, y:y*unitsPerPixel }), getWorldUnitsPerPixel: () => unitsPerPixel, setViewBox, viewBox, containerRef: ref,
    currentSchemeId: schemeId, onMoveEnd: move, onConnectEnd: connect, onSelectComponent: select, onSelectConnection: selectConnection });
  return <div ref={ref} onMouseDown={state.handleMouseDown} onMouseMove={state.handleMouseMove}
    onMouseUp={state.handleMouseUp} onMouseLeave={state.resetInteraction} />;
}
function dispatch(type: string, x: number, y: number, buttons = type === 'mouseup' ? 0 : 1) {
  container.firstElementChild!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons }));
}
async function event(type: string, x: number, y: number, buttons?: number) { await act(async () => dispatch(type, x, y, buttons)); }
beforeEach(async () => {
  vi.resetAllMocks(); projectionOffset = 0; unitsPerPixel=1; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); });

test('overview clicks select the body while exact ports still connect without moving objects',async()=>{
  unitsPerPixel=5;
  const original=components;
  await event('mousedown',32,23);await event('mouseup',32,23);
  expect(select).toHaveBeenCalledWith(1);
  expect(connect).not.toHaveBeenCalled();expect(move).not.toHaveBeenCalled();
  expect(components).toBe(original);
  await event('mousedown',20,23);await event('mouseup',80,23);
  expect(connect).toHaveBeenCalledExactlyOnceWith(1,1,2,'left','left');
  expect(components).toBe(original);expect(move).not.toHaveBeenCalled();
});

test('picks the routed detour and leaves the obsolete straight chord empty', async () => {
  await act(async () => root.render(<Harness wire />));
  await event('mousedown',310,82); await event('mouseup',310,82);
  expect(selectConnection).toHaveBeenLastCalledWith(9);
  selectConnection.mockClear();
  await event('mousedown',310,115); await event('mouseup',310,115);
  expect(selectConnection).toHaveBeenLastCalledWith(null);
  expect(selectConnection).not.toHaveBeenCalledWith(9);
  expect(move).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
});

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
  const original=components;
  await event('mousedown', 160, 115); await event('mousemove', 180, 135); await event('mouseup', 160, 115);
  expect(components[0]).toMatchObject({ x: 100, y: 100 }); expect(move).not.toHaveBeenCalled();
  expect(components).toBe(original);
});

test('pointer frames change only the preview, retaining the committed graph until one final commit',async()=>{
  const original=components;
  await event('mousedown',160,115);
  for(let i=1;i<=20;i++)await event('mousemove',160+i*2,115+i);
  expect(components).toBe(original);
  expect(state.movePreview).toMatchObject({componentId:1,x:140,y:120,schemeId:1});
  expect(move).not.toHaveBeenCalled();
  await event('mouseup',210,145);
  expect(state.movePreview).toBeNull();
  expect(components[0]).toMatchObject({x:150,y:130});
  expect(move).toHaveBeenCalledExactlyOnceWith(1,150,130);
});

test('cancelling a preview preserves independently received geometry instead of restoring the gesture start',async()=>{
  await event('mousedown',160,115);await event('mousemove',190,145);
  await act(async()=>replace(previous=>previous.map(c=>c.id===1?{...c,x:800,y:900,revision:'2'}:c)));
  await act(async()=>state.resetInteraction());
  expect(state.movePreview).toBeNull();
  expect(components[0]).toMatchObject({x:800,y:900,revision:'2'});
  expect(move).not.toHaveBeenCalled();
});

test('dropping an independently deleted object cannot dispatch a stale write',async()=>{
  await event('mousedown',160,115);await event('mousemove',190,145);
  await act(async()=>replace(previous=>previous.filter(c=>c.id!==1)));
  await event('mouseup',200,150);
  expect(state.movePreview).toBeNull();expect(move).not.toHaveBeenCalled();
});

test('an old gesture cannot restore geometry into a different scheme or complete a connection there', async () => {
  await event('mousedown', 160, 115); await event('mousemove', 180, 135);
  await act(async () => { root.render(<Harness schemeId={2} />); });
  await act(async () => replace([{ ...first, x: 900, y: 900 }]));
  await event('mouseup', 180, 135);
  expect(components[0]).toMatchObject({ x: 900, y: 900 }); expect(move).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
});
