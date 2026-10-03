import { useState, useCallback, useRef } from 'react';
import { EditorComponent, EditorConnection, DragMode, DragData, TempLine, ViewBox } from '../editor-utils';

import { worldPorts, containsComponent, connectionPoints, distanceToPolyline } from '../editor-geometry';
import { viewportTransform } from '../editor-viewport';

interface UseCanvasInteractionProps {
  components: EditorComponent[];
  setComponents: React.Dispatch<React.SetStateAction<EditorComponent[]>>;
  connections: EditorConnection[];
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
  getWorldUnitsPerPixel: () => number;
  setViewBox: React.Dispatch<React.SetStateAction<ViewBox>>;
  viewBox: ViewBox;
  containerRef: React.RefObject<HTMLDivElement | null>;
  currentSchemeId?: number;
  onMoveEnd: (compId: number, x: number, y: number) => void;
  onConnectEnd: (schemeId: number, from: number, to: number, fromPort: string, toPort: string) => void;
  onSelectComponent: (id: number | null) => void;
  onSelectConnection: (id: number | null) => void;
}

type Gesture =
  | { mode: 'move'; schemeId?: number; componentId: number; x: number; y: number; offsetX: number; offsetY: number; startX: number; startY: number; moved: boolean }
  | { mode: 'connect'; schemeId?: number; componentId: number; portName: string }
  | { mode: 'pan'; schemeId?: number; startX: number; startY: number; vb: ViewBox };

export function useCanvasInteraction({
  components, setComponents, connections, screenToWorld, getWorldUnitsPerPixel, setViewBox, viewBox, containerRef, currentSchemeId,
  onMoveEnd, onConnectEnd, onSelectComponent, onSelectConnection,
}: UseCanvasInteractionProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragData, setDragData] = useState<DragData | null>(null);
  const [tempLine, setTempLine] = useState<TempLine | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const clearGesture = useCallback(() => {
    gesture.current = null;
    setDragMode(null); setDragData(null); setTempLine(null);
  }, []);
  const resetInteraction = useCallback(() => {
    const active = gesture.current;
    clearGesture();
    // A cancelled preview is not a saved position. Preserve all other fields.
    if (active?.mode === 'move' && active.moved && active.schemeId === currentSchemeId) {
      setComponents(previous => previous.map(component => component.id === active.componentId
        ? { ...component, x: active.x, y: active.y } : component));
    }
  }, [clearGesture, currentSchemeId, setComponents]);

  const getZoom = useCallback(() => 1600 / viewBox.w, [viewBox.w]);

  const findPortAt = useCallback((wx: number, wy: number) => {
    const thresh = 14 * getWorldUnitsPerPixel();
    for (let i = components.length - 1; i >= 0; i--) {
      const c = components[i];

      for (const p of worldPorts(c)) {
        if (Math.hypot(wx - p.x, wy - p.y) <= thresh) return { comp: c, port: p };
      }
    }
    return null;
  }, [components, getWorldUnitsPerPixel]);

  const findCompAt = useCallback((wx: number, wy: number) => {
    for (let i = components.length - 1; i >= 0; i--) {
      const c = components[i];

      if (containsComponent(c, { x: wx, y: wy })) return c;
    }
    return null;
  }, [components]);

  const findConnAt = useCallback((wx: number, wy: number): EditorConnection | null => {
    const thresh = 8 * getWorldUnitsPerPixel();
    for (const conn of connections) {
      const points = connectionPoints(conn, components);
      if (points && distanceToPolyline({ x: wx, y: wy }, points) <= thresh) return conn;
    }
    return null;
  }, [components, connections, getWorldUnitsPerPixel]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    resetInteraction();
    const w = screenToWorld(e.clientX, e.clientY);
    const portHit = findPortAt(w.x, w.y);
    if (portHit) {
      e.stopPropagation();
      setDragMode('connect');
      gesture.current = { mode: 'connect', schemeId: currentSchemeId, componentId: portHit.comp.id, portName: portHit.port.name };
      setDragData({ compId: portHit.comp.id, portName: portHit.port.name });
      setTempLine({
        x1: portHit.port.x,
        y1: portHit.port.y,
        x2: w.x, y2: w.y,
      });
      return;
    }
    const compHit = findCompAt(w.x, w.y);
    if (compHit) {
      e.stopPropagation();
      onSelectComponent(compHit.id);
      onSelectConnection(null);
      setDragMode('move');
      gesture.current = { mode: 'move', schemeId: currentSchemeId, componentId: compHit.id, x: compHit.x, y: compHit.y,
        offsetX: w.x - compHit.x, offsetY: w.y - compHit.y, startX: e.clientX, startY: e.clientY, moved: false };
      setDragData({ compId: compHit.id, offsetX: w.x - compHit.x, offsetY: w.y - compHit.y });
      return;
    }
    const connHit = findConnAt(w.x, w.y);
    if (connHit) {
      e.stopPropagation();
      onSelectConnection(connHit.id);
      onSelectComponent(null);
      return;
    }
    setDragMode('pan');
    gesture.current = { mode: 'pan', schemeId: currentSchemeId, startX: e.clientX, startY: e.clientY, vb: { ...viewBox } };
    setDragData({ startX: e.clientX, startY: e.clientY, vb: { ...viewBox } });
    onSelectComponent(null);
    onSelectConnection(null);
  }, [screenToWorld, viewBox, findPortAt, findCompAt, findConnAt, onSelectComponent, onSelectConnection, currentSchemeId, resetInteraction]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const active = gesture.current;
    if (!active) return;
    if (e.buttons !== 1 || active.schemeId !== currentSchemeId) { resetInteraction(); return; }
    const w = screenToWorld(e.clientX, e.clientY);
    if (active.mode === 'move') {
      // Screen-pixel threshold separates selection from a deliberate drag at
      // any zoom, including reflow of the inspector after selection.
      if (!active.moved && Math.hypot(e.clientX - active.startX, e.clientY - active.startY) < 3) return;
      active.moved = true;
      setComponents(prev => prev.map(c =>
        c.id === active.componentId
          ? { ...c, x: w.x - active.offsetX, y: w.y - active.offsetY }
          : c
      ));
    } else if (active.mode === 'connect') {
      setTempLine(prev => prev ? { ...prev, x2: w.x, y2: w.y } : null);
    } else if (active.mode === 'pan') {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) { resetInteraction(); return; }
      const scale = viewportTransform(active.vb, rect).scale;
      const dx = (e.clientX - active.startX) / scale;
      const dy = (e.clientY - active.startY) / scale;
      setViewBox({ ...active.vb, x: active.vb.x - dx, y: active.vb.y - dy });
    }
  }, [screenToWorld, setComponents, setViewBox, containerRef, currentSchemeId, resetInteraction]);

  const handleMouseUp = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const active = gesture.current;
    if (!active) return;
    if (active.schemeId !== currentSchemeId) { resetInteraction(); return; }
    const w = screenToWorld(e.clientX, e.clientY);
    // Clear synchronously before dispatch: duplicate mouseup cannot create a
    // second wire, and a late connection acknowledgement cannot end a new drag.
    clearGesture();
    if (active.mode === 'connect' && currentSchemeId) {
      const portHit = findPortAt(w.x, w.y);
      if (portHit && portHit.comp.id !== active.componentId) {
        await onConnectEnd(currentSchemeId, active.componentId, portHit.comp.id, active.portName, portHit.port.name);
      }
    } else if (active.mode === 'move' && (active.moved || Math.hypot(e.clientX - active.startX, e.clientY - active.startY) >= 3)) {
      const x = w.x - active.offsetX, y = w.y - active.offsetY;
      setComponents(previous => previous.map(component => component.id === active.componentId ? { ...component, x, y } : component));
      if (x !== active.x || y !== active.y) onMoveEnd(active.componentId, x, y);
    }
  }, [currentSchemeId, screenToWorld, findPortAt, onMoveEnd, onConnectEnd, clearGesture, resetInteraction, setComponents]);

  return {
    dragMode, dragData, tempLine,
    handleMouseDown, handleMouseMove, handleMouseUp,
    resetInteraction,
    findCompAt, getZoom,
  };
}
