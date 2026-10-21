// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { useCanvasViewport } from './useCanvasViewport';

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let viewport: ReturnType<typeof useCanvasViewport>;
function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  viewport = useCanvasViewport(ref);
  return <div ref={ref} onWheel={viewport.handleWheel} />;
}
function wheel(deltaY: number, deltaX = 0) {
  container.firstElementChild!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX, deltaY, clientX: 300, clientY: 200 }));
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); root = createRoot(container);
  await act(async () => root.render(<Harness />));
  container.firstElementChild!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500 } as DOMRect);
});
afterEach(async () => { await act(async () => root.unmount()); });

test('horizontal or empty wheel input does not change the view', async () => {
  const initial = { ...viewport.viewBox };
  await act(async () => { wheel(0, 30); wheel(0); });
  expect(viewport.viewBox).toEqual(initial);
});

test('batched wheel events accumulate and keep the same world point under the cursor', async () => {
  const anchor = viewport.screenToWorld(300, 200);
  await act(async () => { wheel(-1); wheel(-1); });
  expect(viewport.viewBox.w).toBeCloseTo(1296, 10);
  expect(viewport.viewBox.h).toBeCloseTo(810, 10);
  const after = viewport.screenToWorld(300, 200);
  expect(after.x).toBeCloseTo(anchor.x, 10); expect(after.y).toBeCloseTo(anchor.y, 10);
});

test('repeated toolbar and wheel zoom remain finite, bounded and reversible', async () => {
  await act(async () => { for (let i = 0; i < 8000; i++) viewport.zoomIn(); });
  expect(viewport.getZoom()).toBeCloseTo(100, 10);
  await act(async () => { wheel(-1); });
  expect(viewport.getZoom()).toBeCloseTo(100, 10);
  await act(async () => { for (let i = 0; i < 8000; i++) viewport.zoomOut(); });
  expect(viewport.getZoom()).toBeCloseTo(0.01, 10);
  await act(async () => { wheel(-1); });
  expect(viewport.getZoom()).toBeGreaterThan(0.01);
  expect(Object.values(viewport.viewBox).every(Number.isFinite)).toBe(true);
});
