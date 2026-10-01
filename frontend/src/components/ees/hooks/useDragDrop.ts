import { useCallback } from 'react';
import { ComponentLibraryItem } from '../svg-components';

interface UseDragDropProps {
  addComponent: (item: ComponentLibraryItem, wx: number, wy: number) => Promise<void>;
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
}

export function useDragDrop({ addComponent, screenToWorld }: UseDragDropProps) {
  const handleLibDragStart = useCallback((e: React.DragEvent, item: ComponentLibraryItem) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/json', JSON.stringify(item));
  }, []);

  const handleCanvasDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    try {
      const item = JSON.parse(e.dataTransfer.getData('application/json')) as ComponentLibraryItem;
      const w = screenToWorld(e.clientX, e.clientY);
      await addComponent(item, w.x, w.y);
    } catch (err) { console.error(err); }
  }, [addComponent, screenToWorld]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  return { handleLibDragStart, handleCanvasDrop, handleDragOver };
}