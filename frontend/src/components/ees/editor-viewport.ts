import type { ViewBox } from './editor-utils';

/** Matches the root SVG's preserveAspectRatio="xMidYMid meet", including letterboxing. */
export function viewportTransform(viewBox: ViewBox, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>) {
  if (![viewBox.x, viewBox.y, viewBox.w, viewBox.h, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || viewBox.w <= 0 || viewBox.h <= 0 || rect.width <= 0 || rect.height <= 0) throw new Error('Холст не имеет корректного размера');
  const scale = Math.min(rect.width / viewBox.w, rect.height / viewBox.h);
  return { scale, left: rect.left + (rect.width - viewBox.w * scale) / 2, top: rect.top + (rect.height - viewBox.h * scale) / 2 };
}

export function screenToViewBox(viewBox: ViewBox, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, clientX: number, clientY: number) {
  const transform = viewportTransform(viewBox, rect);
  return { x: viewBox.x + (clientX - transform.left) / transform.scale, y: viewBox.y + (clientY - transform.top) / transform.scale };
}
