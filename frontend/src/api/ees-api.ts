// frontend/src/api/ees-api.ts
import { componentRevisionHeaders, parseComponentRevision, parseCreatedComponent, readComponentWrite, type ComponentWriteResult, type CreatedComponent } from './component-revision';
export type { ComponentWriteResult, CreatedComponent } from './component-revision';

const API_BASE = '/api/ees';

export interface ComputeCapability {
  model_group: string;
  method: string;
  status: 'unsupported' | 'experimental' | 'validated' | 'deprecated';
  summary: string;
  reasons: string[];
}

/** Read the worker registry. Unknown or malformed states must not enable calculations. */
export async function getComputeCapabilities(signal?: AbortSignal): Promise<ComputeCapability[]> {
  const response = await fetch(`${API_BASE}/capabilities`, { signal });
  if (!response.ok) throw new Error('Сервис расчёта недоступен');
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('capabilities' in data) || !Array.isArray(data.capabilities)) {
    throw new Error('Некорректный реестр расчётных возможностей');
  }
  return data.capabilities.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Некорректная запись реестра');
    const entry = value as Record<string, unknown>;
    if (typeof entry.model_group !== 'string' || typeof entry.method !== 'string' || typeof entry.summary !== 'string' ||
        !['unsupported', 'experimental', 'validated', 'deprecated'].includes(String(entry.status)) ||
        !Array.isArray(entry.reasons) || !entry.reasons.every(reason => typeof reason === 'string')) {
      throw new Error('Некорректная запись реестра');
    }
    return entry as unknown as ComputeCapability;
  });
}

/** Keep the structured worker diagnostic visible through the gateway. */
export function calculationErrorMessage(data: unknown): string {
  if (!data || typeof data !== 'object' || !('error' in data)) return 'Не удалось выполнить расчёт';
  if ('error_detail' in data && data.error_detail && typeof data.error_detail === 'object') {
    const detail = data.error_detail as Record<string, unknown>;
    if (typeof detail.message === 'string') return detail.message + (typeof detail.detail === 'string' && detail.detail ? `: ${detail.detail}` : '');
  }
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error === 'object') {
    const error = data.error as Record<string, unknown>;
    if (typeof error.message === 'string') {
      return error.message + (typeof error.detail === 'string' ? `: ${error.detail}` : '');
    }
  }
  return 'Не удалось выполнить расчёт';
}

export interface ComponentType {
  id: number;
  code: string;
  name: string;
  category: string;
  description: string;
}

export interface ComponentParam {
  key: string;
  name: string;
  type: string;
  default: string;
  unit: string;
}

export interface SchemeComponent {
  revision: string;
  equipmentModelId?: number | null;
  id: number;
  type: string;
  typeId: number;
  name: string;
  x: number;
  y: number;
  rotation: number;
  params: Record<string, string>;
}

export interface SchemeConnection {
  validationErrors?: string[];
  id: number;
  from: number;
  to: number;
  fromPort: string;
  toPort: string;
}

export interface Scheme {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  owner_id: number;
  components?: SchemeComponent[];
  connections?: SchemeConnection[];
}

export interface CalculationSource {
  component_id: number;
  type: 'slack' | 'pv' | 'pq';
  internal_bus: number;
  terminal_bus: number;
  p_mw: number;
  q_mvar: number;
  q_limits_applied: boolean;
  q_limit_status?: 'clamped' | 'within_bounds' | 'not_declared';
  q_min_emf_mvar?: number;
  q_max_emf_mvar?: number;
}

export interface CalculationIsland {
  island_id: number;
  bus_ids: number[];
  slack_bus: number;
  slack_component: number;
  iterations: number;
  max_mismatch_pu: number;
  computation_time_ms: number;
  balance: { residual_p_mw: number; residual_q_mvar: number };
}

export interface CalculationResult {
  success: boolean;
  error?: string;
  nodes: Array<{
    island?: number;
    node_id: number;
    node_type: string;
    voltage: number;
    angle: number;
    phase: number;
    quadrature: number;
  }>;
  node_count: number;
  iterations: number;
  computation_time_ms: number;
  method_used: string;
  capability?: ComputeCapability;
  warnings?: string[];
  assumptions?: string[];
  sources?: CalculationSource[];
  island_results?: CalculationIsland[];
}

export interface EquipmentModel {
  id: number;
  model_name: string;
  manufacturer: string;
  description: string;
}

/** Validate the fields rendered by the editor before accepting an external result. */
export function parseCalculationResult(data: unknown): CalculationResult {
  const fail = () => { throw new Error('Сервис вернул некорректный результат расчёта'); };
  if (!data || typeof data !== 'object') return fail();
  const result = data as Record<string, unknown>;
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (result.success !== true || !Array.isArray(result.nodes) || !Number.isSafeInteger(result.node_count) ||
      result.node_count !== result.nodes.length || !finite(result.iterations) || !Number.isSafeInteger(result.iterations) || result.iterations < 0 ||
      !finite(result.computation_time_ms) || result.computation_time_ms < 0 || typeof result.method_used !== 'string') return fail();
  const nodeIds = new Set<number>();
  const nodeById = new Map<number, { island?: unknown; node_type: string }>();
  for (const node of result.nodes) {
    if (!node || typeof node !== 'object' || !Number.isSafeInteger(node.node_id) || typeof node.node_type !== 'string' ||
        !finite(node.voltage) || node.voltage < 0 || !finite(node.angle) || !finite(node.phase) || !finite(node.quadrature) || nodeIds.has(node.node_id)) return fail();
    nodeIds.add(node.node_id);
    nodeById.set(node.node_id, node);
  }
  for (const field of ['warnings', 'assumptions']) {
    const values = result[field];
    if (values !== undefined && (!Array.isArray(values) || !values.every(value => typeof value === 'string'))) return fail();
  }
  if (result.sources !== undefined) {
    if (!Array.isArray(result.sources)) return fail();
    const ids = new Set<number>();
    for (const raw of result.sources) {
      if (!raw || typeof raw !== 'object') return fail();
      const source = raw as Record<string, unknown>;
      if (!Number.isSafeInteger(source.component_id) || Number(source.component_id) <= 0 || ids.has(Number(source.component_id)) ||
          !['slack', 'pv', 'pq'].includes(String(source.type)) ||
          !Number.isSafeInteger(source.internal_bus) || Number(source.internal_bus) <= 0 ||
          !Number.isSafeInteger(source.terminal_bus) || Number(source.terminal_bus) <= 0 ||
          !nodeIds.has(Number(source.internal_bus)) || !nodeIds.has(Number(source.terminal_bus)) || source.internal_bus === source.terminal_bus ||
          !finite(source.p_mw) || !finite(source.q_mvar) || typeof source.q_limits_applied !== 'boolean') return fail();
      ids.add(Number(source.component_id));
      if (source.q_limit_status !== undefined && !['clamped', 'within_bounds', 'not_declared'].includes(String(source.q_limit_status))) return fail();
      if (source.q_limits_applied) {
        if (!['clamped', 'within_bounds'].includes(String(source.q_limit_status)) || !finite(source.q_min_emf_mvar) ||
            !finite(source.q_max_emf_mvar) || source.q_min_emf_mvar > source.q_max_emf_mvar ||
            (source.q_limit_status === 'clamped' && source.type !== 'pq')) return fail();
      } else if (source.q_limit_status !== undefined && source.q_limit_status !== 'not_declared') return fail();
    }
  }
  if (result.island_results !== undefined) {
    if (!Array.isArray(result.island_results) || result.island_results.length === 0) return fail();
    const islandIds = new Set<number>();
    const assigned = new Set<number>();
    let totalIterations = 0;
    for (const raw of result.island_results) {
      if (!raw || typeof raw !== 'object') return fail();
      const island = raw as Record<string, unknown>;
      if (!Number.isSafeInteger(island.island_id) || Number(island.island_id) <= 0 || islandIds.has(Number(island.island_id)) ||
          !Array.isArray(island.bus_ids) || island.bus_ids.length === 0 ||
          !Number.isSafeInteger(island.slack_bus) || !island.bus_ids.includes(island.slack_bus) ||
          !Number.isSafeInteger(island.slack_component) || Number(island.slack_component) <= 0 ||
          !finite(island.iterations) || !Number.isSafeInteger(island.iterations) || island.iterations < 0 ||
          !finite(island.max_mismatch_pu) || island.max_mismatch_pu < 0 ||
          !finite(island.computation_time_ms) || island.computation_time_ms < 0 ||
          nodeById.get(Number(island.slack_bus))?.node_type !== 'slack') return fail();
      islandIds.add(Number(island.island_id));
      totalIterations += island.iterations;
      for (const id of island.bus_ids) {
        if (!Number.isSafeInteger(id) || !nodeIds.has(id) || assigned.has(id) ||
            nodeById.get(id)?.island !== island.island_id) return fail();
        assigned.add(id);
      }
      const balance = island.balance as Record<string, unknown> | undefined;
      if (!balance || typeof balance !== 'object' || !finite(balance.residual_p_mw) || !finite(balance.residual_q_mvar)) return fail();
      if (Array.isArray(result.sources) && !result.sources.some(source => source.component_id === island.slack_component &&
          source.internal_bus === island.slack_bus && source.type === 'slack')) return fail();
    }
    if (assigned.size !== nodeIds.size || totalIterations !== result.iterations) return fail();
  }
  if (result.capability !== undefined) {
    const c = result.capability;
    if (!c || typeof c !== 'object' || !('status' in c) || !['unsupported', 'experimental', 'validated', 'deprecated'].includes(String(c.status)) ||
        !('reasons' in c) || !Array.isArray(c.reasons) || !c.reasons.every(reason => typeof reason === 'string')) return fail();
  }
  return data as CalculationResult;
}

// Component types
export async function getComponentTypes(): Promise<ComponentType[]> {
  const response = await fetch(`${API_BASE}/component-types`);
  if (!response.ok) throw new Error('Failed to fetch component types');
  return response.json();
}

export async function getComponentParams(code: string): Promise<ComponentParam[]> {
  const response = await fetch(`${API_BASE}/component-params/${code}`);
  if (!response.ok) throw new Error('Failed to fetch component params');
  return response.json();
}

export async function getEquipmentModels(code: string): Promise<EquipmentModel[]> {
  const response = await fetch(`${API_BASE}/equipment-models/${code}`);
  if (!response.ok) throw new Error('Failed to fetch equipment models');
  return response.json();
}

export async function getEquipmentModelParams(id: number): Promise<Record<string, string>> {
  const response = await fetch(`${API_BASE}/equipment-model/${id}`);
  if (!response.ok) throw new Error('Failed to fetch equipment model params');
  return response.json();
}

// Schemes
export async function getSchemes(): Promise<Scheme[]> {
  const response = await fetch(`${API_BASE}/schemes`);
  if (!response.ok) throw new Error('Failed to fetch schemes');
  return response.json();
}

export async function createScheme(name: string, description: string): Promise<{ id: number; success: boolean }> {
  const response = await fetch(`${API_BASE}/schemes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
  if (!response.ok) throw new Error('Failed to create scheme');
  return response.json();
}

export async function getScheme(id: number): Promise<Scheme> {
  const response = await fetch(`${API_BASE}/schemes/${id}`);
  if (!response.ok) throw new Error('Failed to fetch scheme');
  const scheme: Scheme = await response.json();
  for (const component of scheme.components ?? []) parseComponentRevision(component.revision);
  return scheme;
}

export async function deleteScheme(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/schemes/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete scheme');
}

// Components
export async function addComponent(
  schemeId: number,
  typeId: number,
  x: number,
  y: number,
  rotation: number,
  name: string,
  equipmentModelId: number | null = null,
  params: Record<string, string> = {}
): Promise<CreatedComponent> {
  const response = await fetch(`${API_BASE}/components`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemeId, typeId, x, y, rotation, name, equipmentModelId, params }),
  });
  if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(typeof failure.error === 'string' ? failure.error : 'Не удалось сохранить оборудование'); }
  return parseCreatedComponent(await response.json());
}

export async function updateComponent(
  id: number,
  x: number,
  y: number,
  rotation: number,
  name: string,
  revision: string
): Promise<ComponentWriteResult> {
  const response = await fetch(`${API_BASE}/components/${id}`, {
    method: 'PUT',
    headers: componentRevisionHeaders(revision),
    body: JSON.stringify({ x, y, rotation, name }),
  });
  return readComponentWrite(response);
}

export async function deleteComponent(id: number, revision: string): Promise<ComponentWriteResult> {
  const response = await fetch(`${API_BASE}/components/${id}`, { method: 'DELETE', headers: componentRevisionHeaders(revision) });
  return readComponentWrite(response);
}

export interface ComponentPatch {
  pose?: Partial<Pick<SchemeComponent, 'x' | 'y' | 'rotation' | 'name'>>;
  params?: Record<string, string>;
}

/** Atomically save only reviewed fields; the server preserves unselected values. */
export async function patchComponent(id: number, patch: ComponentPatch, revision: string): Promise<ComponentWriteResult> {
  const response = await fetch(`${API_BASE}/components/${id}`, {
    method: 'PATCH', headers: componentRevisionHeaders(revision), body: JSON.stringify(patch),
  });
  return readComponentWrite(response);
}

export async function setComponentParam(
  componentId: number,
  key: string,
  value: string,
  revision: string
): Promise<ComponentWriteResult> {
  const response = await fetch(`${API_BASE}/components/${componentId}/params`, {
    method: 'POST',
    headers: componentRevisionHeaders(revision),
    body: JSON.stringify({ key, value }),
  });
  return readComponentWrite(response);
}

// Connections
export async function addConnection(
  schemeId: number,
  from: number,
  to: number,
  fromPort: string,
  toPort: string
): Promise<{ id: number; success: boolean }> {
  const response = await fetch(`${API_BASE}/connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemeId, from, to, fromPort, toPort }),
  });
  if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(typeof failure.error === 'string' ? failure.error : 'Не удалось сохранить соединение'); }
  const acknowledgement = await response.json();
  if (!acknowledgement || acknowledgement.success !== true || !Number.isSafeInteger(acknowledgement.id) || acknowledgement.id <= 0) {
    throw new Error('Создание соединения не подтверждено сервером');
  }
  return { id: acknowledgement.id, success: true };
}

export async function deleteConnection(id: number): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE}/connections/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete connection');
  const acknowledgement = await response.json();
  if (!acknowledgement || acknowledgement.success !== true) throw new Error('Удаление соединения не подтверждено сервером');
  return { success: true };
}

// Calculation
export async function calculateScheme(schemeId: number, method: string = 'newton-raphson', modelGroup: string = 'three-phase'): Promise<CalculationResult> {
  const response = await fetch(`${API_BASE}/calculate/${schemeId}?modelGroup=${encodeURIComponent(modelGroup)}&method=${encodeURIComponent(method)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data: unknown = await response.json();
  if (!response.ok || (data && typeof data === 'object' && 'success' in data && data.success === false)) {
    throw new Error(calculationErrorMessage(data));
  }
  return parseCalculationResult(data);
}
