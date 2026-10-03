import { expect, test } from 'vitest';
import { screenToViewBox, viewportTransform } from './editor-viewport';

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
