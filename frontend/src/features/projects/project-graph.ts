import type { EditorComponent, EditorConnection } from '../../components/ees/editor-utils';
export interface ProjectGraph { id: string; projectId: string; name: string; description: string; topologyRevision: string; components: EditorComponent[]; connections: EditorConnection[] }
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректный снимок схемы');
  return value as Record<string, unknown>;
};
// The current SQL graph has INTEGER IDs. Conversion is confined to the existing
// renderer; project/session IDs and revisions retain their exact string form.
const rendererId = (value: unknown): number => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || Number(value) > 2147483647) throw new Error('ID графа не поддержан текущим renderer');
  return Number(value);
};
const text = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Некорректный текст снимка'); return value; };
const finite = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) throw new Error('Некорректная геометрия схемы'); return value; };
const revision = (value: unknown, zero = false): string => {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)) throw new Error('Некорректная ревизия схемы');
  return value;
};
export function parseProjectGraph(value: unknown, projectId: string, schemeId: string): ProjectGraph {
  const graph = row(value);
  if (graph.projectId !== projectId || graph.id !== schemeId || !Array.isArray(graph.components) || !Array.isArray(graph.connections)) throw new Error('Снимок не соответствует открытому проекту и схеме');
  const components = graph.components.map(value => {
    const item = row(value);
    const params = row(item.params);
    if (!Object.values(params).every(value => typeof value === 'string')) throw new Error('Некорректные параметры оборудования');
    const rotation = finite(item.rotation);
    if (!Number.isInteger(rotation)) throw new Error('Некорректный поворот оборудования');
    return { id: rendererId(item.id), typeId: rendererId(item.typeId), type: text(item.type), name: text(item.name), x: finite(item.x), y: finite(item.y), rotation,
      revision: revision(item.revision), equipmentModelId: item.equipmentModelId === null ? null : rendererId(item.equipmentModelId), params: params as Record<string, string> };
  });
  const connections = graph.connections.map(value => {
    const item = row(value);
    if (!Array.isArray(item.validationErrors) || !item.validationErrors.every(value => typeof value === 'string')) throw new Error('Некорректная диагностика связей');
    return { id: rendererId(item.id), from: rendererId(item.from), to: rendererId(item.to), fromPort: text(item.fromPort), toPort: text(item.toPort), validationErrors: item.validationErrors as string[] };
  });
  if (new Set(components.map(item => item.id)).size !== components.length || new Set(connections.map(item => item.id)).size !== connections.length) throw new Error('Повторяющиеся ID графа');
  return { id: schemeId, projectId, name: text(graph.name), description: text(graph.description), topologyRevision: revision(graph.topologyRevision, true), components, connections };
}
