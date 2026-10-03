import { useState, useCallback, useRef } from 'react';
import { EditorComponent, getCompSize, ViewBox } from '../editor-utils';
import { screenToViewBox, viewportTransform } from '../editor-viewport';

const DEFAULT_VIEWBOX: ViewBox = { x: -500, y: -300, w: 1600, h: 1000 };

export function useCanvasViewport(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [viewBox, setViewBox] = useState<ViewBox>(DEFAULT_VIEWBOX);
  const viewRef = useRef(viewBox);
  viewRef.current = viewBox;

  const getZoom = useCallback(() => 1600 / viewRef.current.w, []);
  const getWorldUnitsPerPixel = useCallback(() => 1 / viewportTransform(viewRef.current,
    containerRef.current!.getBoundingClientRect()).scale, [containerRef]);

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const vb = viewRef.current;
    return screenToViewBox(vb, rect, clientX, clientY);
  }, [containerRef]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const vb = viewRef.current;
    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    setViewBox({
      x: wx - (wx - vb.x) * factor,
      y: wy - (wy - vb.y) * factor,
      w: vb.w * factor,
      h: vb.h * factor,
    });
  }, [screenToWorld]);

  const zoomIn = useCallback(() => {
    setViewBox(v => { const f = 0.9; const cx = v.x + v.w / 2, cy = v.y + v.h / 2; return { x: cx - v.w * f / 2, y: cy - v.h * f / 2, w: v.w * f, h: v.h * f }; });
  }, []);

  const zoomOut = useCallback(() => {
    setViewBox(v => { const f = 1.1; const cx = v.x + v.w / 2, cy = v.y + v.h / 2; return { x: cx - v.w * f / 2, y: cy - v.h * f / 2, w: v.w * f, h: v.h * f }; });
  }, []);

  const resetView = useCallback(() => setViewBox(DEFAULT_VIEWBOX), []);

  const fitView = useCallback((components: EditorComponent[]) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0 || !components.length) { resetView(); return; }
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const component of components) {
      const size = getCompSize(component.type);
      const angle = (component.rotation || 0) * Math.PI / 180;
      const width = Math.abs(size.w * Math.cos(angle)) + Math.abs(size.h * Math.sin(angle));
      const height = Math.abs(size.w * Math.sin(angle)) + Math.abs(size.h * Math.cos(angle));
      const cx = component.x + size.w / 2, cy = component.y + size.h / 2;
      left = Math.min(left, cx - width / 2); right = Math.max(right, cx + width / 2);
      top = Math.min(top, cy - height / 2); bottom = Math.max(bottom, cy + height / 2 + 24);
    }
    const aspect = rect.width / rect.height;
    const h = Math.max(bottom - top + 120, (right - left + 120) / aspect, 300);
    const w = h * aspect;
    setViewBox({ x: (left + right - w) / 2, y: (top + bottom - h) / 2, w, h });
  }, [containerRef, resetView]);

  return {
    viewBox, setViewBox, viewRef,
    getZoom, getWorldUnitsPerPixel, screenToWorld, handleWheel,
    zoomIn, zoomOut, resetView, fitView,
  };
}
