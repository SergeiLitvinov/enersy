import * as catalog from '../../api/ees-api';
import { ComponentWriteError } from '../../api/component-revision';
import * as commands from '../../api/project-scheme-api';
import { readProjectScheme, SessionError } from '../../api/projects-api';
import type { SchemeTransport, EditorScheme } from '../../components/ees/scheme-transport';
import { parseProjectGraph, type ProjectGraph } from './project-graph';

type Options = commands.ProjectSchemeScope & {
  name: string; writable: boolean; signal: AbortSignal;
  onUnavailable?: () => void;
  onCalculation?: (source: commands.ProjectCalculation['source']) => void;
};
function rendererId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 10 || Number(value) > 2147483647) throw new Error('ID графа не поддержан текущим renderer');
  return Number(value);
}
/** Compare physical membership/endpoints only. Geometry and parameter races are
 * resolved independently by object CAS, never adopted as topology equivalence. */
function structure(graph: Pick<ProjectGraph, 'components' | 'connections'>): string {
  return JSON.stringify({
    components: graph.components.map(item => [item.id, item.typeId]).sort((a, b) => a[0] - b[0]),
    connections: graph.connections.map(item => [item.id, item.from, item.to, item.fromPort, item.toPort]).sort((a, b) => Number(a[0]) - Number(b[0])),
  });
}
/** One scheme/account lifetime; caller owns cancellation and a fresh ComponentWrites.
 * This adapter never accesses legacy graph endpoints. Catalog metadata is shared.
 */
export function createProjectEditorTransport(options: Options): SchemeTransport {
  const { projectId, schemeId, signal, writable, onUnavailable, onCalculation } = options;
  const scope = Object.freeze({ projectId, schemeId });
  const sid = rendererId(schemeId);
  let snapshot: ProjectGraph | null = null;
  let tail: Promise<void> = Promise.resolve();
  let uncertain = false;
  // Retain original CAS/payload only for commands whose outcome still needs review.
  const attempts = new Map<string, { expected: string; input: commands.ProjectConnectionInput }>();
  const checkScheme = (id: number) => { if (id !== sid) throw new Error('Схема не принадлежит открытому контексту'); };
  const graphId = (id: number): string => { if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new Error('Некорректный ID графа'); return String(id); };
  const current = (): ProjectGraph => { if (!snapshot) throw new Error('Сначала загрузите исходную схему'); return snapshot; };
  const write = () => { signal.throwIfAborted(); if (!writable) throw new Error('Проект доступен только для чтения'); };
  async function checked<T>(action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try { const value = await action(); signal.throwIfAborted(); return value; }
    catch (error) {
      if (!signal.aborted && (error instanceof ComponentWriteError || error instanceof SessionError) && [401, 404].includes(error.status)) onUnavailable?.();
      throw error;
    }
  }
  // Object queues alone cannot serialize unrelated structural mutations.
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(() => checked(action));
    tail = result.then(() => {}, () => {});
    return result;
  }
  async function read(): Promise<ProjectGraph> {
    return parseProjectGraph(await readProjectScheme(projectId, schemeId, signal), projectId, schemeId);
  }
  async function synchronize(expected: Pick<ProjectGraph, 'components' | 'connections'>) {
    const fresh = await read();
    if (structure(fresh) !== structure(expected)) throw new Error('Состав схемы изменился. Сверьте сохранённую топологию');
    snapshot = fresh;
  }
  function structural<T>(action: () => Promise<T>): Promise<T> {
    return serialized(async () => {
      write();
      if (uncertain) throw new Error('Исходная топология не подтверждена. Сверьте схему');
      try { return await action(); }
      catch (error) { uncertain = true; throw error; }
    });
  }
  function component(id: number) {
    const key = graphId(id);
    if (!current().components.some(item => item.id === id)) throw new Error('Оборудование отсутствует в открытом снимке');
    return key;
  }
  const unsupported = async (): Promise<never> => { throw new Error('Создавайте схемы в навигаторе проекта. Удаление приватной схемы пока не подключено'); };
  return {
    getComponentTypes: catalog.getComponentTypes,
    getComponentParams: catalog.getComponentParams,
    getSchemes: async () => { signal.throwIfAborted(); return [{ id: sid, name: options.name }]; },
    getScheme: (id): Promise<EditorScheme> => serialized(async () => {
      checkScheme(id);
      snapshot = await read(); uncertain = false;
      return { id: sid, name: snapshot.name, description: snapshot.description, components: snapshot.components, connections: snapshot.connections };
    }),
    createScheme: unsupported, deleteScheme: unsupported,
    newConnectionCommandId: catalog.newConnectionCommandId,
    addComponent: (id, typeId, x, y, rotation, name, equipmentModelId = null, params = {}) => structural(async () => {
      checkScheme(id);
      const before = current();
      const created = await commands.createProjectComponent(scope, { typeId: graphId(typeId), x, y, rotation, name,
        equipmentModelId: equipmentModelId === null ? null : graphId(equipmentModelId), params }, signal);
      const cid = rendererId(created.id);
      await synchronize({ components: [...before.components, { id: cid, typeId, type: '', name, x, y, rotation, revision: created.revision, params: created.params }], connections: before.connections });
      return { ...created, id: cid, equipmentModelId: created.equipmentModelId === null ? null : rendererId(created.equipmentModelId) };
    }),
    deleteComponent: (id, revision) => structural(async () => {
      const key = component(id), before = current();
      const acknowledgement = await commands.deleteProjectComponent(scope, key, revision, signal);
      await synchronize({ components: before.components.filter(item => item.id !== id), connections: before.connections.filter(item => item.from !== id && item.to !== id) });
      return acknowledgement;
    }),
    updateComponent: (id, x, y, rotation, name, revision) => checked(async () => { write(); return commands.updateProjectComponent(scope, component(id), { x, y, rotation, name }, revision, signal); }),
    patchComponent: (id, patch, revision) => checked(async () => { write(); return commands.patchProjectComponent(scope, component(id), patch, revision, signal); }),
    setComponentParam: (id, key, value, revision) => checked(async () => { write(); return commands.setProjectComponentParam(scope, component(id), key, value, revision, signal); }),
    addConnection: async (id, from, to, fromPort, toPort, commandId) => {
      checkScheme(id);
      if (!commandId) return Promise.reject(new Error('Требуется UUID команды связи'));
      const input = { from: graphId(from), to: graphId(to), fromPort, toPort };
      const previous = attempts.get(commandId);
      // Explicit reviewed replay may use a now-missing endpoint; the server journal
      // authorizes it before returning the historical acknowledgement.
      if (previous) return serialized(async () => {
        write();
        if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw new Error('Данные повторной команды изменены');
        const acknowledgement = await commands.createProjectConnection(scope, previous.input, commandId, previous.expected, signal);
        return { success: true, id: rendererId(acknowledgement.id), commandId };
      });
      return structural(async () => {
        component(from); component(to);
        const before = current();
        attempts.set(commandId, { input, expected: before.topologyRevision });
        const acknowledgement = await commands.createProjectConnection(scope, input, commandId, before.topologyRevision, signal);
        if (acknowledgement.deleted) throw new Error('Повторная команда относится к удалённой связи. Сверьте топологию');
        const cid = rendererId(acknowledgement.id);
        await synchronize({ components: before.components, connections: [...before.connections, { id: cid, from, to, fromPort, toPort }] });
        attempts.delete(commandId);
        return { success: true, id: cid, commandId };
      });
    },
    deleteConnection: (id) => structural(async () => {
      const before = current();
      if (!before.connections.some(item => item.id === id)) throw new Error('Связь отсутствует в открытом снимке');
      await commands.deleteProjectConnection(scope, graphId(id), before.topologyRevision, signal);
      await synchronize({ components: before.components, connections: before.connections.filter(item => item.id !== id) });
      return { success: true };
    }),
    calculateScheme: (id, method = 'newton-raphson', group = 'three-phase') => serialized(async () => {
      write(); checkScheme(id);
      if (uncertain) throw new Error('Исходная топология не подтверждена. Сверьте схему');
      const calculation = await commands.calculateProjectScheme(scope, current().topologyRevision, method, group, signal);
      onCalculation?.(calculation.source);
      return calculation.result;
    }),
  };
}
