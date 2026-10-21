import { expect, test } from 'vitest';
import { screenToViewBox, viewportTransform, zoomViewBox, visibleWorldBounds } from './editor-viewport';

test('visible bounds include wide and tall SVG margins and pixel overscan at the actual scale', () => {
  const view={x:0,y:0,w:100,h:100};
  expect(visibleWorldBounds(view,800,100,0)).toEqual({left:-350,right:450,top:0,bottom:100});
  expect(visibleWorldBounds(view,100,800,0)).toEqual({left:0,right:100,top:-350,bottom:450});
  expect(visibleWorldBounds(view,200,200,32)).toEqual({left:-16,right:116,top:-16,bottom:116});
  expect(()=>visibleWorldBounds(view,0,100)).toThrow();
});

test.each([
  [{ left: 10, top: 20, width: 1000, height: 500 }, 260, 270],
  [{ left: 10, top: 20, width: 500, height: 1000 }, 10, 520],
  [{ left: 10, top: 20, width: 500, height: 500 }, 10, 270],
])('picking follows the rendered square SVG in landscape, portrait and equal-size canvases', (rect, x, y) => {
  expect(screenToViewBox({ x: -100, y: -200, w: 1000, h: 1000 }, rect, x, y)).toEqual({ x: -100, y: 300 });
});

test('wheel zoom preserves the point under the cursor after panels change the aspect ratio', () => {
  const rect = { left: 25, top: 30, width: 800, height: 300 };
  const view = { x: -200, y: -100, w: 1600, h: 1000 };
  const point = screenToViewBox(view, rect, 425, 130);
  const factor = 0.9;
  const zoomed = { x: point.x - (point.x - view.x) * factor, y: point.y - (point.y - view.y) * factor, w: view.w * factor, h: view.h * factor };
  const after = screenToViewBox(zoomed, rect, 425, 130);
  expect(after.x).toBeCloseTo(point.x, 10); expect(after.y).toBeCloseTo(point.y, 10);
  expect(viewportTransform(view, rect).scale).toBe(0.3);
});

test('a zero-sized or non-finite transform is rejected rather than producing plausible coordinates', () => {
  expect(() => viewportTransform({ x: 0, y: 0, w: 100, h: 100 }, { left: 0, top: 0, width: 0, height: 100 })).toThrow();
  expect(() => viewportTransform({ x: 0, y: 0, w: Infinity, h: 100 }, { left: 0, top: 0, width: 100, height: 100 })).toThrow();
});

test('clamped zoom keeps the cursor anchor and aspect ratio in a letterboxed canvas', () => {
  const rect = { left: 25, top: 30, width: 800, height: 300 };
  const view = { x: -200, y: -100, w: 17, h: 10 };
  const anchor = screenToViewBox(view, rect, 125, 130);
  const next = zoomViewBox(view, 0.9, anchor);
  expect(next.w).toBe(16);
  expect(next.w / next.h).toBeCloseTo(1.7, 12);
  const after = screenToViewBox(next, rect, 125, 130);
  expect(after.x).toBeCloseTo(anchor.x, 10); expect(after.y).toBeCloseTo(anchor.y, 10);
});

test('a large fitted network can zoom inward gradually without snapping or zooming further out', () => {
  const view = { x: -200000, y: -100000, w: 800000, h: 400000 };
  expect(zoomViewBox(view, 1.1)).toBe(view);
  const next = zoomViewBox(view, 0.9);
  expect(next).toEqual({ x: -160000, y: -80000, w: 720000, h: 360000 });
});
