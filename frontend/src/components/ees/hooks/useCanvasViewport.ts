import { useState, useCallback, useRef } from 'react';
import { EditorComponent, getCompSize, ViewBox } from '../editor-utils';
import { screenToViewBox, viewportTransform, zoomViewBox } from '../editor-viewport';

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
    if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const { clientX, clientY } = e;
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    // Resolve each queued event against its predecessor, including React batches.
    setViewBox(vb => zoomViewBox(vb, factor, screenToViewBox(vb, rect, clientX, clientY)));
  }, [containerRef]);

  const zoomIn = useCallback(() => {
    setViewBox(v => zoomViewBox(v, 0.9));
  }, []);

  const zoomOut = useCallback(() => {
    setViewBox(v => zoomViewBox(v, 1.1));
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
