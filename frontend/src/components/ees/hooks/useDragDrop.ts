import { useCallback } from 'react';
import { ComponentLibraryItem } from '../svg-components';

const EQUIPMENT_TYPE = 'application/x-enersy-equipment-type+json';

interface UseDragDropProps {
  addComponent: (item: ComponentLibraryItem, wx: number, wy: number) => Promise<void>;
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
  library: ComponentLibraryItem[];
  enabled: boolean;
  onError: (message: string) => void;
}

export function useDragDrop({ addComponent, screenToWorld, library, enabled, onError }: UseDragDropProps) {
  const handleLibDragStart = useCallback((e: React.DragEvent, item: ComponentLibraryItem) => {
    if (!enabled || !library.some(entry => entry.id === item.id && entry.code === item.code)) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(EQUIPMENT_TYPE, JSON.stringify({ version: 1, typeId: item.id, code: item.code }));
  }, [enabled, library]);

  const accepts = useCallback((data: DataTransfer) => enabled && !data.files.length && Array.from(data.types).includes(EQUIPMENT_TYPE), [enabled]);

  const handleCanvasDrop = useCallback(async (e: React.DragEvent) => {
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    try {
      const raw = e.dataTransfer.getData(EQUIPMENT_TYPE);
      if (raw.length > 4096) throw new Error('Некорректная ссылка на оборудование');
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('version' in value) || value.version !== 1
        || !('typeId' in value) || !Number.isSafeInteger(value.typeId) || Number(value.typeId) <= 0
        || !('code' in value) || typeof value.code !== 'string') throw new Error('Некорректная ссылка на оборудование');
      const item = library.find(entry => entry.id === value.typeId && entry.code === value.code);
      if (!item) throw new Error('Тип оборудования отсутствует в текущем каталоге. Выберите его в библиотеке.');
      const w = screenToWorld(e.clientX, e.clientY);
      if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) throw new Error('Не удалось определить место добавления на схеме');
      await addComponent(item, w.x, w.y);
    } catch { onError('Не удалось добавить оборудование перетаскиванием. Выберите тип в текущей библиотеке и повторите.'); }
  }, [accepts, library, addComponent, screenToWorld, onError]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!accepts(e.dataTransfer)) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [accepts]);

  return { handleLibDragStart, handleCanvasDrop, handleDragOver };
}
