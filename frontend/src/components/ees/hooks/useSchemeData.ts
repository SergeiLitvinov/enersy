import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../../../api/ees-api';
import { EditorComponent, EditorConnection } from '../editor-utils';
import { ComponentLibraryItem } from '../svg-components';
import { useNotify } from '../../NotificationProvider';
import { ComponentWrites, type ComponentPose } from '../component-writes';
import { ComponentWriteError } from '../../../api/component-revision';
import type { ComponentDraft } from '../component-drafts';
import type { GraphReview, GraphSnapshot } from '../graph-writes';

async function readGraphServer(schemeId: number) {
  const server = await api.getScheme(schemeId);
  if (server.id !== schemeId || !Array.isArray(server.components) || !Array.isArray(server.connections)) {
    throw new Error('Сервер не подтвердил полный состав исходной схемы');
  }
  const snapshot: GraphSnapshot = { id: server.id, components: server.components, connections: server.connections };
  const templates = new Map<number, api.ComponentParam[]>();
  await Promise.all(snapshot.components.map(async component => {
    templates.set(component.id, await api.getComponentParams(component.type).catch(() => []));
  }));
  return { snapshot, templates };
}

function writeErrorMessage(error: unknown, fallback: string) {
  return error instanceof ComponentWriteError ? error.message : fallback;
}

export function useSchemeData(schemeId?: number, writeQueue?: ComponentWrites) {
  const { notify } = useNotify();
  const [components, setComponents] = useState<EditorComponent[]>([]);
  const [connections, setConnections] = useState<EditorConnection[]>([]);
  const [library, setLibrary] = useState<ComponentLibraryItem[]>([]);
  const [currentSchemeId, selectScheme] = useState<number | undefined>(schemeId);
  const [schemes, setSchemes] = useState<{ id: number; name: string }[]>([]);
  const [isCalculating, setIsCalculating] = useState(false);
  const [calculationError, setCalculationError] = useState('');
  const [loadedSchemeId, setLoadedSchemeId] = useState<number | undefined>(undefined);
  const [, refreshRecovery] = useState(0);
  const [parameterResets, setParameterResets] = useState<Record<number, Record<string, number>>>({});
  // A view has identity beyond the scheme ID: A → B → A invalidates A's old replies.
  const activeView = useRef({ schemeId });
  const calculationRequest = useRef<object | null>(null);
  const writes = useRef(writeQueue ?? new ComponentWrites());
  const graphReviews = useRef(new WeakMap<GraphReview, { isCurrent: () => boolean; version: number; templates: Map<number, api.ComponentParam[]> }>());
  const captureView = useCallback(() => {
    const view = activeView.current;
    return () => activeView.current === view;
  }, []);
  const setCurrentSchemeId = useCallback((id: number | undefined) => {
    if (activeView.current.schemeId === id) return;
    activeView.current = { schemeId: id };
    calculationRequest.current = null;
    setIsCalculating(false);
    selectScheme(id);
  }, []);
  useEffect(() => () => {
    activeView.current = { ...activeView.current };
    calculationRequest.current = null;
  }, []);

  useEffect(() => {
    api.getComponentTypes().then(setLibrary).catch(console.error);
    api.getSchemes().then(list => setSchemes(list)).catch(console.error);
  }, []);

  useEffect(() => {
    let active = true;
    setCalculationError('');
    setLoadedSchemeId(undefined);
    setComponents([]);
    setParameterResets({});
    setConnections([]);
    if (currentSchemeId) {
      writes.current.settle().then(() => {
        if (!active) return undefined;
        writes.current.reset();
        return api.getScheme(currentSchemeId);
      }).then(async s => {
        if (!s || !active) return;
        const comps = s.components || [];
        const withParams = await Promise.all(comps.map(async (c: api.SchemeComponent) => {
          try {
            const params = await api.getComponentParams(c.type);
            return { ...c, paramTemplate: params };
          } catch { return { ...c, paramTemplate: [] }; }
        }));
        if (!active) return;
        for (const component of withParams) writes.current.seed(currentSchemeId, component);
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
    const isCurrent = captureView();
    try {
      const result = await api.createScheme(name, description);
      if (isCurrent()) setCurrentSchemeId(result.id);
      setSchemes(prev => [...prev, { id: result.id, name }]);
      return true;
    } catch (e) { console.error(e); notify('Не удалось создать схему', 'error'); return false; }
  }, [notify, captureView, setCurrentSchemeId]);

  const handleDeleteScheme = useCallback(async (sid: number) => {
    const isCurrent = captureView();
    const s = schemes.find(x => x.id === sid);
    if (!confirm(`Удалить "${s?.name}"?`)) return;
    try {
      await api.deleteScheme(sid);
      setSchemes(prev => prev.filter(x => x.id !== sid));
      if (isCurrent() && currentSchemeId === sid) {
        setCurrentSchemeId(undefined);
        setComponents([]);
        setConnections([]);
      }
    } catch (e) { console.error(e); notify('Не удалось удалить', 'error'); }
  }, [schemes, currentSchemeId, captureView, setCurrentSchemeId, notify]);

  const addComponent = useCallback(async (item: ComponentLibraryItem, wx: number, wy: number, equipmentModelId: number | null = null) => {
    if (!currentSchemeId) return;
    const isCurrent = captureView();
    try {
      const params = await api.getComponentParams(item.code);
      // No write was dispatched yet; a selection change cancels this intent.
      if (!isCurrent()) return;
      const r = await writes.current.graph.run(currentSchemeId,
        { kind: 'create-component', typeId: item.id, name: item.name, x: wx, y: wy, equipmentModelId },
        () => api.addComponent(currentSchemeId, item.id, wx, wy, 0, item.name, equipmentModelId));
      if (!isCurrent()) return;
      writes.current.seed(currentSchemeId, {
        id: r.id, revision: r.revision, type: item.code, typeId: item.id, name: item.name,
        x: wx, y: wy, rotation: 0, params: r.params, equipmentModelId: r.equipmentModelId,
      });
      setComponents(prev => [...prev, {
        id: r.id, revision: r.revision, type: item.code, typeId: item.id, name: item.name,
        x: wx, y: wy, rotation: 0, params: r.params, equipmentModelId: r.equipmentModelId, paramTemplate: params,
      }]);
    } catch (e) { if (isCurrent()) { refreshRecovery(version => version + 1); notify('Не удалось подтвердить сохранение оборудования. Проверьте схему после повторной загрузки.', 'error'); } throw e; }
  }, [currentSchemeId, notify, captureView]);

  const deleteSelectedComponent = useCallback(async (id: number) => {
    const component = components.find(c => c.id === id);
    if (!component || !currentSchemeId) return;
    const isCurrent = captureView();
    try {
      const result = await writes.current.run(component, isCurrent, revision => api.deleteComponent(id, revision),
        { schemeId: currentSchemeId, intent: { kind: 'delete' } });
      if (!result) return;
      if (!isCurrent()) return;
      setComponents(prev => prev.filter(c => c.id !== id));
      setConnections(prev => prev.filter(c => c.from !== id && c.to !== id));
    } catch (error) { if (isCurrent()) { refreshRecovery(version => version + 1); notify(writeErrorMessage(error, 'Не удалось подтвердить удаление оборудования. Повторно загрузите исходную схему.'), 'error'); } }
  }, [components, currentSchemeId, captureView, notify]);

  const deleteConnection = useCallback(async (id: number) => {
    if (!currentSchemeId) return;
    const isCurrent = captureView();
    try {
      await writes.current.graph.run(currentSchemeId, { kind: 'delete-connection', id }, () => api.deleteConnection(id));
      if (!isCurrent()) return;
      setConnections(prev => prev.filter(c => c.id !== id));
    } catch { if (isCurrent()) { refreshRecovery(version => version + 1); notify('Удаление соединения не подтверждено. Требуется сверка топологии; расчёт заблокирован.', 'error'); } }
  }, [currentSchemeId, captureView, notify]);

  const handleCalculate = useCallback(async (modelGroup?: string, method?: string) => {
    if (!currentSchemeId) { notify('Создайте или выберите схему', 'info'); return null; }
    if (calculationRequest.current) return null;
    const isCurrent = captureView();
    const request = {};
    calculationRequest.current = request;
    setIsCalculating(true);
    setCalculationError('');
    try {
      await writes.current.settleForCalculation(currentSchemeId);
      if (!isCurrent()) return null;
      writes.current.assertConfirmed(currentSchemeId);
      const result = await api.calculateScheme(currentSchemeId, method, modelGroup);
      return isCurrent() ? result : null;
    } catch (e) { if (isCurrent()) { const message = e instanceof Error ? e.message : 'Ошибка при расчёте'; setCalculationError(message); notify(message, 'error'); } }
    finally {
      if (calculationRequest.current === request) {
        calculationRequest.current = null;
        setIsCalculating(false);
      }
    }
    return null;
  }, [currentSchemeId, notify, captureView]);

  const updatePose = useCallback(async (id: number, change: (pose: ComponentPose) => ComponentPose) => {
    const component = components.find(c => c.id === id);
    if (!component || !currentSchemeId) return;
    const isCurrent = captureView();
    try {
      const pose = await writes.current.pose(component, change, isCurrent,
        (p, revision) => api.updateComponent(id, p.x, p.y, p.rotation, p.name, revision), currentSchemeId);
      if (pose && isCurrent()) setComponents(prev => prev.map(c => c.id === id ? { ...c, rotation: pose.rotation, revision: pose.revision } : c));
    } catch (error) { if (isCurrent()) { refreshRecovery(version => version + 1); notify(writeErrorMessage(error, 'Не удалось подтвердить сохранение оборудования. Повторно загрузите исходную схему.'), 'error'); } }
  }, [components, currentSchemeId, captureView, notify]);
  const updateComponentPosition = useCallback((id: number, x: number, y: number) => updatePose(id, p => ({ ...p, x, y })), [updatePose]);
  const rotateComponent = useCallback((id: number) => updatePose(id, p => ({ ...p, rotation: (p.rotation + 90) % 360 })), [updatePose]);
  const saveComponentParam = useCallback(async (id: number, key: string, value: string) => {
    const component = components.find(c => c.id === id);
    if (!component || !currentSchemeId) return;
    const isCurrent = captureView();
    try {
      const result = await writes.current.run(component, isCurrent, revision => api.setComponentParam(id, key, value, revision),
        { schemeId: currentSchemeId, intent: { kind: 'parameter', key, value } });
      if (result && isCurrent()) setComponents(prev => prev.map(c => c.id === id ? { ...c, revision: result.revision, params: { ...c.params, [key]: value } } : c));
    } catch (error) { if (isCurrent()) { refreshRecovery(version => version + 1); notify(writeErrorMessage(error, 'Не удалось подтвердить сохранение параметра. Повторно загрузите исходную схему.'), 'error'); } }
  }, [components, currentSchemeId, captureView, notify]);

  const addConnection = useCallback(async (schemeId: number, from: number, to: number, fromPort: string, toPort: string) => {
    if (schemeId !== activeView.current.schemeId) return;
    const isCurrent = captureView();
    try {
      const commandId = api.newConnectionCommandId();
      const r = await writes.current.graph.run(schemeId,
        { kind: 'create-connection', commandId, from, to, fromPort, toPort }, () => api.addConnection(schemeId, from, to, fromPort, toPort, commandId));
      if (!isCurrent()) return;
      setConnections(prev => [...prev, {
        id: r.id, from, to, fromPort, toPort,
      }]);
    } catch (err) { if (isCurrent()) { refreshRecovery(version => version + 1); notify(err instanceof Error ? err.message : 'Не удалось сохранить соединение', 'error'); } }
  }, [notify, captureView]);

  const reviewGraph = useCallback(async (): Promise<GraphReview> => {
    if (!currentSchemeId) throw new Error('Выберите исходную схему');
    const isCurrent = captureView();
    await writes.current.settleForCalculation(currentSchemeId);
    if (!isCurrent()) throw new Error('Рабочий контекст изменился. Повторно откройте сверку.');
    const version = writes.current.version;
    let templates = new Map<number, api.ComponentParam[]>();
    const review = await writes.current.graph.review(currentSchemeId, async () => {
      const read = await readGraphServer(currentSchemeId);
      templates = read.templates;
      return read.snapshot;
    });
    if (!isCurrent() || version !== writes.current.version) throw new Error('Во время чтения появились правки. Повторно откройте сверку.');
    graphReviews.current.set(review, { isCurrent, version, templates });
    return review;
  }, [currentSchemeId, captureView]);

  const applyGraphSnapshot = useCallback((server: GraphSnapshot, templates: Map<number, api.ComponentParam[]>) => {
    if (!currentSchemeId || server.id !== currentSchemeId) throw new Error('Рабочая схема изменилась');
    const failedIds = new Set(writes.current.drafts.failed(currentSchemeId).map(draft => draft.componentId));
    for (const component of server.components) if (!failedIds.has(component.id)) writes.current.seed(currentSchemeId, component);
    setComponents(previous => {
      const local = new Map(previous.map(component => [component.id, component]));
      const present = new Set(server.components.map(component => component.id));
      return [
        ...server.components.map(component => failedIds.has(component.id) && local.has(component.id) ? local.get(component.id)! :
          { ...component, paramTemplate: local.get(component.id)?.paramTemplate ?? templates.get(component.id) ?? [] }),
        ...previous.filter(component => failedIds.has(component.id) && !present.has(component.id)),
      ];
    });
    setConnections(server.connections);
    setCalculationError('');
  }, [currentSchemeId]);

  const acceptGraphServer = useCallback(async (review: GraphReview, selected: ReadonlySet<number>) => {
    const context = graphReviews.current.get(review);
    if (!currentSchemeId || !context?.isCurrent() || context.version !== writes.current.version) {
      throw new Error('Сравнение устарело. Повторно откройте сверку.');
    }
    const server = writes.current.graph.acceptServer(review, currentSchemeId, new Set(selected));
    applyGraphSnapshot(server, context.templates);
    graphReviews.current.delete(review);
    refreshRecovery(version => version + 1);
  }, [currentSchemeId, applyGraphSnapshot]);

  const retryGraphConnection = useCallback(async (review: GraphReview, failureId: number) => {
    const context = graphReviews.current.get(review);
    if (!currentSchemeId || !context?.isCurrent() || context.version !== writes.current.version) {
      throw new Error('Сравнение устарело. Повторно откройте сверку.');
    }
    const expectedGraphVersion = writes.current.graph.versionFor(currentSchemeId) + 1;
    const unchanged = () => context.isCurrent() && context.version === writes.current.version;
    const assertFresh = () => {
      if (!unchanged() || writes.current.graph.versionFor(currentSchemeId) !== expectedGraphVersion) {
        throw new Error('Во время повтора появились правки. Повторно сверьте состав схемы.');
      }
    };
    try {
      await writes.current.graph.retryConnection(review, currentSchemeId, failureId, unchanged,
        intent => api.addConnection(currentSchemeId, intent.from, intent.to, intent.fromPort, intent.toPort, intent.commandId),
        async () => {
          assertFresh();
          const read = await readGraphServer(currentSchemeId);
          assertFresh();
          applyGraphSnapshot(read.snapshot, read.templates);
        });
    } finally {
      graphReviews.current.delete(review);
      if (context.isCurrent()) refreshRecovery(version => version + 1);
    }
  }, [currentSchemeId, applyGraphSnapshot]);

  const resolveComponentDraft = useCallback(async (draft: ComponentDraft, server: api.SchemeComponent, fields: ReadonlySet<string>, mode: 'apply' | 'accept') => {
    if (draft.schemeId !== currentSchemeId) throw new Error('Повторно откройте исходную схему');
    const isCurrent = captureView();
    try {
      const confirmed = await writes.current.recover(draft, server, fields, isCurrent,
        mode === 'apply' ? (patch, revision) => api.patchComponent(server.id, patch, revision) : undefined);
      if (confirmed && isCurrent()) {
        setComponents(prev => prev.map(component => component.id === confirmed.id ? { ...component, ...confirmed } : component));
        // Reset only explicitly resolved parameter inputs, even when accepting
        // the same confirmed value. Keep other fields and normal-save focus.
        setParameterResets(previous => {
          const counters = { ...previous[confirmed.id] };
          for (const field of fields) {
            if (field.startsWith('parameter:')) {
              const key = field.slice('parameter:'.length);
              const count = Object.prototype.hasOwnProperty.call(counters, key) ? counters[key] : 0;
              Object.defineProperty(counters, key, { value: count + 1, enumerable: true, configurable: true, writable: true });
            }
          }
          return { ...previous, [confirmed.id]: counters };
        });
      }
    } finally {
      if (isCurrent()) refreshRecovery(version => version + 1);
    }
  }, [currentSchemeId, captureView]);

  const resolveComponentDeletion = useCallback(async (draft: ComponentDraft, server: api.SchemeComponent | undefined, mode: 'keep' | 'delete') => {
    if (draft.schemeId !== currentSchemeId) throw new Error('Повторно откройте исходную схему');
    const isCurrent = captureView();
    try {
      const result = await writes.current.recoverDeletion(draft, server, mode, isCurrent,
        revision => api.deleteComponent(draft.componentId, revision));
      if (result && isCurrent()) {
        if (result.deleted) {
          setComponents(prev => prev.filter(component => component.id !== draft.componentId));
          setConnections(prev => prev.filter(connection => connection.from !== draft.componentId && connection.to !== draft.componentId));
        } else if (result.component) {
          const confirmed = result.component;
          setComponents(prev => prev.map(component => component.id === confirmed.id ? { ...component, ...confirmed } : component));
        }
      }
    } finally { if (isCurrent()) refreshRecovery(version => version + 1); }
  }, [currentSchemeId, captureView]);

  return {
    components, setComponents, parameterResets,
    connections, setConnections,
    library, schemes, currentSchemeId, setCurrentSchemeId,
    handleCreateScheme, handleDeleteScheme,
    addComponent, deleteSelectedComponent, deleteConnection,
    handleCalculate, updateComponentPosition, rotateComponent, saveComponentParam, addConnection,
    isCalculating, calculationError, loadedSchemeId, captureView, resolveComponentDraft, resolveComponentDeletion,
    failedDrafts: currentSchemeId ? writes.current.drafts.failed(currentSchemeId) : [],
    failedGraph: currentSchemeId ? writes.current.graph.failed(currentSchemeId) : [], reviewGraph, acceptGraphServer, retryGraphConnection,
  };
}
