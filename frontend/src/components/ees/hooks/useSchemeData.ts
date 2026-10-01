import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../../../api/ees-api';
import { EditorComponent, EditorConnection } from '../editor-utils';
import { ComponentLibraryItem } from '../svg-components';
import { useNotify } from '../../NotificationProvider';

export function useSchemeData(schemeId?: number) {
  const { notify } = useNotify();
  const [components, setComponents] = useState<EditorComponent[]>([]);
  const [connections, setConnections] = useState<EditorConnection[]>([]);
  const [library, setLibrary] = useState<ComponentLibraryItem[]>([]);
  const [currentSchemeId, setCurrentSchemeId] = useState<number | undefined>(schemeId);
  const [schemes, setSchemes] = useState<{ id: number; name: string }[]>([]);
  const [isCalculating, setIsCalculating] = useState(false);
  const [calculationError, setCalculationError] = useState('');
  const [loadedSchemeId, setLoadedSchemeId] = useState<number | undefined>(undefined);
  const activeSchemeRef = useRef(currentSchemeId);
  activeSchemeRef.current = currentSchemeId;

  useEffect(() => {
    api.getComponentTypes().then(setLibrary).catch(console.error);
    api.getSchemes().then(list => setSchemes(list)).catch(console.error);
  }, []);

  useEffect(() => {
    let active = true;
    setCalculationError('');
    setLoadedSchemeId(undefined);
    setComponents([]);
    setConnections([]);
    if (currentSchemeId) {
      api.getScheme(currentSchemeId).then(async s => {
        const comps = s.components || [];
        const withParams = await Promise.all(comps.map(async (c: api.SchemeComponent) => {
          try {
            const params = await api.getComponentParams(c.type);
            return { ...c, paramTemplate: params };
          } catch { return { ...c, paramTemplate: [] }; }
        }));
        if (!active) return;
        setComponents(withParams);
        setConnections(s.connections || []);
        setLoadedSchemeId(currentSchemeId);
      }).catch(() => { if (active) notify('Не удалось загрузить схему. Повторите выбор.', 'error'); });
    } else {
      setComponents([]);
      setConnections([]);
    }
    return () => { active = false; };
  }, [currentSchemeId, notify]);

  const handleCreateScheme = useCallback(async (name: string, description: string) => {
    try {
      const result = await api.createScheme(name, description);
      setCurrentSchemeId(result.id);
      setSchemes(prev => [...prev, { id: result.id, name }]);
      setComponents([]);
      setConnections([]);
      return true;
    } catch (e) { console.error(e); notify('Не удалось создать схему', 'error'); return false; }
  }, [notify]);

  const handleDeleteScheme = useCallback(async (sid: number) => {
    const s = schemes.find(x => x.id === sid);
    if (!confirm(`Удалить "${s?.name}"?`)) return;
    try {
      await api.deleteScheme(sid);
      setSchemes(prev => prev.filter(x => x.id !== sid));
      if (currentSchemeId === sid) {
        setCurrentSchemeId(undefined);
        setComponents([]);
        setConnections([]);
      }
    } catch (e) { console.error(e); notify('Не удалось удалить', 'error'); }
  }, [schemes, currentSchemeId]);

  const addComponent = useCallback(async (item: ComponentLibraryItem, wx: number, wy: number, equipmentModelId: number | null = null) => {
    if (!currentSchemeId) return;
    try {
      const params = await api.getComponentParams(item.code);
      const r = await api.addComponent(currentSchemeId, item.id, wx, wy, 0, item.name, equipmentModelId);
      setComponents(prev => [...prev, {
        id: r.id, type: item.code, typeId: item.id, name: item.name,
        x: wx, y: wy, rotation: 0, params: r.params, equipmentModelId: r.equipmentModelId, paramTemplate: params,
      }]);
    } catch (e) { notify('Не удалось подтвердить сохранение оборудования. Проверьте схему после повторной загрузки.', 'error'); throw e; }
  }, [currentSchemeId, notify]);

  const deleteSelectedComponent = useCallback(async (id: number) => {
    try {
      await api.deleteComponent(id);
      setComponents(prev => prev.filter(c => c.id !== id));
      setConnections(prev => prev.filter(c => c.from !== id && c.to !== id));
    } catch (e) { console.error(e); }
  }, []);

  const deleteConnection = useCallback(async (id: number) => {
    try {
      await api.deleteConnection(id);
      setConnections(prev => prev.filter(c => c.id !== id));
    } catch (e) { console.error(e); }
  }, []);

  const handleCalculate = useCallback(async (modelGroup?: string, method?: string) => {
    if (!currentSchemeId) { notify('Создайте или выберите схему', 'info'); return null; }
    const calculatedSchemeId = currentSchemeId;
    setIsCalculating(true);
    setCalculationError('');
    try {
      const result = await api.calculateScheme(currentSchemeId, method, modelGroup);
      return result;
    } catch (e) { if (activeSchemeRef.current === calculatedSchemeId) { const message = e instanceof Error ? e.message : 'Ошибка при расчёте'; setCalculationError(message); notify(message, 'error'); } }
    finally { setIsCalculating(false); }
    return null;
  }, [currentSchemeId, notify]);

  const updateComponentPosition = useCallback((id: number, x: number, y: number, rotation: number, name: string) => {
    api.updateComponent(id, x, y, rotation, name).catch(console.error);
  }, []);

  const addConnection = useCallback(async (schemeId: number, from: number, to: number, fromPort: string, toPort: string) => {
    try {
      const r = await api.addConnection(schemeId, from, to, fromPort, toPort);
      setConnections(prev => [...prev, {
        id: r.id, from, to, fromPort, toPort,
      }]);
    } catch (err) { notify(err instanceof Error ? err.message : 'Не удалось сохранить соединение', 'error'); }
  }, [notify]);

  return {
    components, setComponents,
    connections, setConnections,
    library, schemes, currentSchemeId, setCurrentSchemeId,
    handleCreateScheme, handleDeleteScheme,
    addComponent, deleteSelectedComponent, deleteConnection,
    handleCalculate, updateComponentPosition, addConnection,
    isCalculating, calculationError, loadedSchemeId,
  };
}
