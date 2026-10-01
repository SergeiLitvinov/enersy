// frontend/src/api/ees-api.ts

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

export interface CalculationResult {
  success: boolean;
  error?: string;
  nodes: Array<{
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
  for (const node of result.nodes) {
    if (!node || typeof node !== 'object' || !Number.isSafeInteger(node.node_id) || typeof node.node_type !== 'string' ||
        !finite(node.voltage) || node.voltage < 0 || !finite(node.angle) || !finite(node.phase) || !finite(node.quadrature)) return fail();
  }
  for (const field of ['warnings', 'assumptions']) {
    const values = result[field];
    if (values !== undefined && (!Array.isArray(values) || !values.every(value => typeof value === 'string'))) return fail();
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
  return response.json();
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
): Promise<{ id: number; success: boolean; params: Record<string, string>; equipmentModelId: number | null }> {
  const response = await fetch(`${API_BASE}/components`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemeId, typeId, x, y, rotation, name, equipmentModelId, params }),
  });
  if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(typeof failure.error === 'string' ? failure.error : 'Не удалось сохранить оборудование'); }
  return response.json();
}

export async function updateComponent(
  id: number,
  x: number,
  y: number,
  rotation: number,
  name: string
): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE}/components/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, rotation, name }),
  });
  if (!response.ok) throw new Error('Failed to update component');
  return response.json();
}

export async function deleteComponent(id: number): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE}/components/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete component');
  return response.json();
}

export async function setComponentParam(
  componentId: number,
  key: string,
  value: string
): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE}/components/${componentId}/params`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  if (!response.ok) throw new Error('Failed to set component param');
  return response.json();
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
  return response.json();
}

export async function deleteConnection(id: number): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE}/connections/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete connection');
  return response.json();
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
