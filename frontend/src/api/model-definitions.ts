import type { ModelParameterSpec } from '../domain/model-parameters';
export interface ModelNode { id: string; label: string; x: number; y: number; terminal: number }
export interface ModelEdge { id: string; from: string; to: string; kind: 'impedance' | 'admittance' | 'source' | 'pq' | 'transformer'; label: string; symbol?: 'inductor' | 'capacitor' }
export interface ModelDefinition { id: string; equipment_type: string; name: string; implementation: string; equations: string[]; limitations: string[]; nodes: ModelNode[]; edges: ModelEdge[]; parameters?: ModelParameterSpec[] }
export interface ModelDefinitions { schema_version: 1 | 2 | 3; kernel_version: string; source_revision: string; source_files: {path: string; sha256: string}[]; model_group: 'three-phase'; method: 'newton-raphson'; status: 'unsupported' | 'experimental' | 'validated' | 'deprecated'; definitions: ModelDefinition[] }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Некорректное описание модели'); return value as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw Error('Некорректный текст модели'); return value; }
function list(value: unknown, limit = 64): unknown[] { if (!Array.isArray(value) || value.length > limit) throw Error('Некорректный список модели'); return value; }
function unique<T extends {id: string}>(items: T[]): T[] { if (new Set(items.map(item => item.id)).size !== items.length) throw Error('Повторяется ID элемента модели'); return items; }
function hash(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{64}$/.test(result)) throw Error('Некорректный отпечаток исходников'); return result; }
function coordinate(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 360) throw Error('Некорректная геометрия представления'); return value; }
export function parseModelDefinitions(raw: unknown): ModelDefinitions {
  const data = object(raw);
  if ((data.schema_version !== 1 && data.schema_version !== 2 && data.schema_version !== 3) || data.model_group !== 'three-phase' || data.method !== 'newton-raphson' || !['unsupported', 'experimental', 'validated', 'deprecated'].includes(String(data.status))) throw Error('Неподдержанный контракт описаний моделей');
  const definitions = unique(list(data.definitions).map(raw => {
    const item = object(raw);
    const nodes = unique(list(item.nodes, 32).map(raw => { const n = object(raw); if (typeof n.terminal !== 'number' || !Number.isInteger(n.terminal) || n.terminal < 0 || n.terminal > 3) throw Error('Некорректный терминал модели'); return { id: text(n.id), label: text(n.label), x: coordinate(n.x), y: coordinate(n.y), terminal: n.terminal }; }));
    if (!nodes.length) throw Error('Модель без узлов');
    const ids = new Set(nodes.map(node => node.id));
    const edges = unique(list(item.edges).map(raw => { const e = object(raw); const from = text(e.from), to = text(e.to);
      if (!ids.has(from) || !ids.has(to) || from === to || typeof e.kind !== 'string' || !['impedance', 'admittance', 'source', 'pq', ...(data.schema_version === 3 ? ['transformer'] : [])].includes(e.kind)) throw Error('Некорректная связь модели');
      if (e.kind === 'transformer') {
        const a = nodes.find(node => node.id === from)!, b = nodes.find(node => node.id === to)!;
        if (a.x === b.x && a.y === b.y) throw Error('Совпадают концы идеального трансформатора');
      }
      if (e.symbol !== undefined) {
        if (typeof e.symbol !== 'string' || !['inductor', 'capacitor'].includes(e.symbol) || !['impedance', 'admittance'].includes(e.kind)) throw Error('Неподдержанный символ элемента замещения');
        const a = nodes.find(node => node.id === from)!, b = nodes.find(node => node.id === to)!;
        if (a.x === b.x && a.y === b.y) throw Error('Совпадают концы элемента замещения');
      }
      return { id: text(e.id), from, to, kind: e.kind as ModelEdge['kind'], label: text(e.label), ...(e.symbol === undefined ? {} : { symbol: e.symbol as ModelEdge['symbol'] }) };
    }));
    const parameters: ModelParameterSpec[] | undefined = data.schema_version !== 1 || item.parameters !== undefined ? list(item.parameters).map(raw => {
      const p = object(raw);
      if (!['number', 'integer', 'boolean'].includes(String(p.kind)) || !['required', 'optional', 'conditional'].includes(String(p.requirement)) || (p.default_value !== null && typeof p.default_value !== 'string')) throw Error('Некорректное описание параметра модели');
      const key = text(p.key);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || (p.default_value !== null && (p.default_value as string).length > 4096)) throw Error('Некорректный ключ или default параметра');
      return { key, name: text(p.name), unit: text(p.unit), kind: p.kind as ModelParameterSpec['kind'], requirement: p.requirement as ModelParameterSpec['requirement'], default_value: p.default_value as string | null, note: text(p.note) };
    }) : undefined;
    if (parameters && new Set(parameters.map(p => p.key)).size !== parameters.length) throw Error('Повторяется ключ параметра модели');
    return { parameters, id: text(item.id), equipment_type: text(item.equipment_type), name: text(item.name), implementation: text(item.implementation), equations: list(item.equations, 32).map(text), limitations: list(item.limitations, 32).map(text), nodes, edges };
  }));
  if (new Set(definitions.map(item => item.equipment_type)).size !== definitions.length) throw Error('Неоднозначная модель типа оборудования');
  const source_files = list(data.source_files).map(raw => { const file = object(raw); const path = text(file.path); if (!/^backend-julia\/src\/[a-zA-Z0-9_/.-]+\.jl$/.test(path) || path.includes('..')) throw Error('Некорректный путь исходника'); return { path, sha256: hash(file.sha256) }; });
  if (!source_files.length || new Set(source_files.map(file => file.path)).size !== source_files.length) throw Error('Некорректный список исходников');
  return { schema_version: data.schema_version, kernel_version: text(data.kernel_version), source_revision: hash(data.source_revision), source_files, model_group: 'three-phase', method: 'newton-raphson', status: data.status as ModelDefinitions['status'], definitions };
}
export async function getModelDefinitions(signal?: AbortSignal): Promise<ModelDefinitions> {
  signal?.throwIfAborted();
  const response = await fetch('/api/ees/model-definitions', { signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw Error('Описания моделей вычислительного ядра недоступны');
  const data: unknown = await response.json(); signal?.throwIfAborted(); return parseModelDefinitions(data);
}
