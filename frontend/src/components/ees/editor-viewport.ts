import type { ViewBox } from './editor-utils';

// Nominal toolbar scale: 1%–10000%. Fit-to-content may exceed this range;
// manual zoom can move back into it without snapping a large fitted network.
export function zoomViewBox(view: ViewBox, factor: number, anchor = { x: view.x + view.w / 2, y: view.y + view.h / 2 }): ViewBox {
  if (!Number.isFinite(factor) || factor <= 0) return view;
  const width = Math.max(Math.min(view.w, 16), Math.min(Math.max(view.w, 160000), view.w * factor));
  if (width === view.w) return view;
  const applied = width / view.w;
  const next = { x: anchor.x - (anchor.x - view.x) * applied, y: anchor.y - (anchor.y - view.y) * applied,
    w: width, h: view.h * applied };
  return Object.values(next).every(Number.isFinite) && next.w > 0 && next.h > 0 ? next : view;
}

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

/** The visible SVG viewport includes the letterboxed margins, not just viewBox. */
export function visibleWorldBounds(view:ViewBox,width:number,height:number,overscanPixels=32) {
  const rect={left:0,top:0,width,height};
  const a=screenToViewBox(view,rect,-overscanPixels,-overscanPixels);
  const b=screenToViewBox(view,rect,width+overscanPixels,height+overscanPixels);
  const bounds={left:a.x,right:b.x,top:a.y,bottom:b.y};
  return Object.values(bounds).every(Number.isFinite)?bounds:null;
}
