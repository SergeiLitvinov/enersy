export type ComputeBackendId = 'julia' | 'julia-rust-jacobian';
export const backendLabel = (id: ComputeBackendId) => id === 'julia' ? 'Julia' : 'Julia + Rust · экспериментальный';
export const isComputeBackendId = (value: unknown): value is ComputeBackendId => value === 'julia' || value === 'julia-rust-jacobian';
export interface CalculationBackend {
  id: ComputeBackendId; version: string; julia_version: string;
  jacobian: 'julia' | 'rust'; linear_solver: 'umfpack';
  julia_core_version?: string; julia_core_sha256?: string; library_sha256?: string; adapter_sha256?: string;
}
export function parseCalculationBackend(solver: unknown): CalculationBackend | undefined {
  const fail = (): never => { throw new Error('Некорректные сведения о вычислительном движке'); };
  if (solver === undefined) return undefined;
  if (!solver || typeof solver !== 'object' || Array.isArray(solver)) return fail();
  const value = (solver as Record<string, unknown>).compute_backend;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const b = value as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256;
  const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  if (!isComputeBackendId(b.id) || !text(b.version) || !text(b.julia_version) || b.linear_solver !== 'umfpack' ||
      b.jacobian !== (b.id === 'julia' ? 'julia' : 'rust')) return fail();
  if (b.id === 'julia-rust-jacobian' && (!text(b.julia_core_version) ||
      !hash(b.julia_core_sha256) || !hash(b.library_sha256) || !hash(b.adapter_sha256))) return fail();
  if (b.julia_core_version !== undefined && !text(b.julia_core_version)) return fail();
  if (['julia_core_sha256', 'library_sha256', 'adapter_sha256'].some(key => b[key] !== undefined && !hash(b[key]))) return fail();
  return value as CalculationBackend;
}
export function requireSelectedBackend(solver: unknown, expected?: ComputeBackendId): void {
  const backend = parseCalculationBackend(solver);
  if (expected && backend?.id !== expected) throw new Error('Сервис не подтвердил выбранный вычислительный движок');
}
export async function getComputeBackends(signal: AbortSignal): Promise<ComputeBackendId[]> {
  signal.throwIfAborted();
  const response = await fetch('/api/ees/compute-backends', { signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Не удалось проверить вычислительные движки');
  const data: unknown = await response.json(); signal.throwIfAborted();
  if (!data || typeof data !== 'object' || !('compute_backends' in data)) throw new Error('Некорректный список движков');
  const ids = data.compute_backends;
  if (!Array.isArray(ids) || !ids.length || ids.length > 2 || !ids.every(isComputeBackendId) || new Set(ids).size !== ids.length) throw new Error('Некорректный список движков');
  return ids;
}
