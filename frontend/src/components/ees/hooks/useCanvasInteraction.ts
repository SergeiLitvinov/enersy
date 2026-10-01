import { useState, useCallback } from 'react';
import { EditorComponent, EditorConnection, DragMode, DragData, TempLine, ViewBox } from '../editor-utils';

import { worldPorts, containsComponent, connectionPoints, distanceToPolyline } from '../editor-geometry';

interface UseCanvasInteractionProps {
  components: EditorComponent[];
  setComponents: React.Dispatch<React.SetStateAction<EditorComponent[]>>;
  connections: EditorConnection[];
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
  setViewBox: React.Dispatch<React.SetStateAction<ViewBox>>;
  viewBox: ViewBox;
  containerRef: React.RefObject<HTMLDivElement | null>;
  currentSchemeId?: number;
  onMoveEnd: (compId: number) => void;
  onConnectEnd: (schemeId: number, from: number, to: number, fromPort: string, toPort: string) => void;
  onSelectComponent: (id: number | null) => void;
  onSelectConnection: (id: number | null) => void;
}

export function useCanvasInteraction({
  components, setComponents, connections, screenToWorld, setViewBox, viewBox, containerRef, currentSchemeId,
  onMoveEnd, onConnectEnd, onSelectComponent, onSelectConnection,
}: UseCanvasInteractionProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragData, setDragData] = useState<DragData | null>(null);
  const [tempLine, setTempLine] = useState<TempLine | null>(null);

  const getZoom = useCallback(() => 1600 / viewBox.w, [viewBox.w]);

  const findPortAt = useCallback((wx: number, wy: number) => {
    const thresh = 14 / getZoom();
    for (let i = components.length - 1; i >= 0; i--) {
      const c = components[i];

      for (const p of worldPorts(c)) {
        if (Math.hypot(wx - p.x, wy - p.y) <= thresh) return { comp: c, port: p };
      }
    }
    return null;
  }, [components, getZoom]);

  const findCompAt = useCallback((wx: number, wy: number) => {
    for (let i = components.length - 1; i >= 0; i--) {
      const c = components[i];

      if (containsComponent(c, { x: wx, y: wy })) return c;
    }
    return null;
  }, [components]);

  const findConnAt = useCallback((wx: number, wy: number): EditorConnection | null => {
    const thresh = 8 / getZoom();
    for (const conn of connections) {
      const points = connectionPoints(conn, components);
      if (points && distanceToPolyline({ x: wx, y: wy }, points) <= thresh) return conn;
    }
    return null;
  }, [components, connections, getZoom]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const w = screenToWorld(e.clientX, e.clientY);
    const portHit = findPortAt(w.x, w.y);
    if (portHit) {
      e.stopPropagation();
      setDragMode('connect');
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
    setDragData({ startX: e.clientX, startY: e.clientY, vb: { ...viewBox } });
    onSelectComponent(null);
    onSelectConnection(null);
  }, [screenToWorld, viewBox, findPortAt, findCompAt, findConnAt, onSelectComponent, onSelectConnection]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (e.buttons !== 1 && !dragMode) return;
    const w = screenToWorld(e.clientX, e.clientY);
    if (dragMode === 'move' && dragData) {
      setComponents(prev => prev.map(c =>
        c.id === dragData.compId
          ? { ...c, x: w.x - (dragData.offsetX ?? 0), y: w.y - (dragData.offsetY ?? 0) }
          : c
      ));
    } else if (dragMode === 'connect') {
      setTempLine(prev => prev ? { ...prev, x2: w.x, y2: w.y } : null);
    } else if (dragMode === 'pan' && dragData && dragData.vb) {
      const rect = containerRef.current!.getBoundingClientRect();
      const dx = (e.clientX - (dragData.startX ?? 0)) / rect.width * dragData.vb.w;
      const dy = (e.clientY - (dragData.startY ?? 0)) / rect.height * dragData.vb.h;
      setViewBox({ ...dragData.vb, x: dragData.vb.x - dx, y: dragData.vb.y - dy });
    }
  }, [dragMode, dragData, screenToWorld, setComponents, setViewBox]);

  const handleMouseUp = useCallback(async (e: React.MouseEvent) => {
    if (!dragMode) return;
    const w = screenToWorld(e.clientX, e.clientY);
    if (dragMode === 'connect' && dragData && currentSchemeId) {
      const portHit = findPortAt(w.x, w.y);
      if (portHit && portHit.comp.id !== dragData.compId) {
        await onConnectEnd(currentSchemeId, dragData.compId!, portHit.comp.id, dragData.portName!, portHit.port.name);
      }
    } else if (dragMode === 'move' && dragData?.compId) {
      onMoveEnd(dragData.compId);
    }
    setDragMode(null);
    setDragData(null);
    setTempLine(null);
  }, [dragMode, dragData, currentSchemeId, screenToWorld, findPortAt, onMoveEnd, onConnectEnd]);

  const resetInteraction = useCallback(() => {
    setDragMode(null);
    setDragData(null);
    setTempLine(null);
  }, []);

  return {
    dragMode, dragData, tempLine,
    handleMouseDown, handleMouseMove, handleMouseUp,
    resetInteraction,
    findCompAt, getZoom,
  };
}
