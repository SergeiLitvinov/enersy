import { SessionError } from './projects-api';
import { parseInputUnitContract, type InputUnitContract } from './input-unit-contract';
import { parseCalculationResult, type CalculationResult } from './ees-api';
import { parseCalculationProvenance, type CalculationProvenance } from './calculation-provenance';
import { isComputeBackendId, requireSelectedBackend, type ComputeBackendId } from './compute-backends';
import { isCalculationBudget, requireExecutionBudget } from './calculation-execution';
import { parseTerminalVoltageLimits, requireOperatingLimits, type TerminalVoltageLimit } from './operating-assessment';

export interface CalculationArchive {
  provenanceSha256?: string; provenanceBytes?: number;
  id: string; schemeId: string; schemeName: string; authorAccountId: string; topologyRevision: string;
  modelGroup: string; method: string; createdAt: string; inputSha256: string; resultSha256: string;
  inputBytes: number; resultBytes: number;
}
export interface ArchiveInput {
  unitContract?: InputUnitContract;
  operatingLimits?: TerminalVoltageLimit[];
  computeBackend?: ComputeBackendId;
  executionOptions?: { max_time_ms: number };
  modelGroup: string; method: string;
  components: { id: number; type: string; x: number; y: number; rotation: number; params: Record<string, string>; parameterUnits?: Record<string, string> }[];
  connections: { from: number; to: number; fromPort: string; toPort: string }[];
}
export interface OpenCalculationArchive { metadata: CalculationArchive; input: ArchiveInput; result: CalculationResult; provenance?: CalculationProvenance }
const fail = (): never => { throw new Error('Некорректный архив расчёта'); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
};
export function archiveId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) return fail();
  return value;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const code = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 8 * 1024 * 1024;
const graphId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
export function parseArchiveMetadata(raw: unknown): CalculationArchive {
  const v = record(raw);
  if ((v.provenanceSha256 !== undefined || v.provenanceBytes !== undefined) && (!hash(v.provenanceSha256) || !bytes(v.provenanceBytes))) return fail();
  archiveId(v.id); archiveId(v.schemeId); archiveId(v.authorAccountId);
  if (BigInt(v.schemeId as string) > 2147483647n || (v.topologyRevision !== '0' && !archiveId(v.topologyRevision)) ||
      typeof v.schemeName !== 'string' || !code(v.modelGroup) || !code(v.method) ||
      typeof v.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(v.createdAt) || !Number.isFinite(Date.parse(v.createdAt)) ||
      !hash(v.inputSha256) || !hash(v.resultSha256) || !bytes(v.inputBytes) || !bytes(v.resultBytes)) return fail();
  return v as unknown as CalculationArchive;
}
export function parseArchiveInput(raw: unknown, metadata: Pick<CalculationArchive, 'modelGroup' | 'method'>): ArchiveInput {
  const v = record(raw);
  const completeUnits = Object.prototype.hasOwnProperty.call(v, 'unitContract');
  if (completeUnits) parseInputUnitContract(v.unitContract);
  if (v.computeBackend !== undefined && !isComputeBackendId(v.computeBackend)) return fail();
  if (v.executionOptions !== undefined) {
    const execution = record(v.executionOptions);
    if (!isCalculationBudget(execution.max_time_ms) || Object.keys(execution).some(key => key !== 'max_time_ms')) return fail();
  }
  if (v.modelGroup !== metadata.modelGroup || v.method !== metadata.method || !Array.isArray(v.components) || !Array.isArray(v.connections)) return fail();
  const ids = new Set<number>();
  for (const value of v.components) {
    const c = record(value), params = record(c.params);
    if (!graphId(c.id) || ids.has(c.id) || !code(c.type) ||
        ![c.x, c.y, c.rotation].every(n => typeof n === 'number' && Number.isFinite(n)) || !Number.isInteger(c.rotation) ||
        !Object.values(params).every(p => typeof p === 'string')) return fail();
    if (c.parameterUnits !== undefined) {
      const units = record(c.parameterUnits);
      if (!Object.entries(units).every(([key, unit]) => typeof unit === 'string' && Object.prototype.hasOwnProperty.call(params, key))) return fail();
      if (completeUnits && (Object.keys(units).length !== Object.keys(params).length || !Object.values(units).every(unit => typeof unit === 'string' && unit.trim().length > 0))) return fail();
    } else if (completeUnits) {
      return fail();
    }
    ids.add(c.id);
  }
  for (const value of v.connections) {
    const c = record(value);
    if (!graphId(c.from) || !graphId(c.to) || !ids.has(c.from) || !ids.has(c.to) || c.from === c.to || !code(c.fromPort) || !code(c.toPort)) return fail();
  }
  if (v.operatingLimits !== undefined && parseTerminalVoltageLimits(v.operatingLimits).some(limit => !ids.has(limit.component_id))) return fail();
  return v as unknown as ArchiveInput;
}
const base = (project: string) => `/api/projects/${archiveId(project)}/calculation-archives`;
async function get(url: string, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  const response = await fetch(url, { signal, credentials: 'same-origin', cache: 'no-store' });
  signal.throwIfAborted();
  if (!response.ok) throw new SessionError(response.status, response.status === 401 || response.status === 404 ? 'Архив или проект недоступен. Проверьте сессию и права.' : 'Не удалось прочитать архив расчётов');
  return response;
}
export async function listCalculationArchives(project: string, signal: AbortSignal, before = ''): Promise<{ items: CalculationArchive[]; nextBeforeId: string }> {
  const response = await get(`${base(project)}?limit=20${before ? `&beforeId=${archiveId(before)}` : ''}`, signal);
  const data = record(await response.json()); signal.throwIfAborted();
  if (!Array.isArray(data.items) || data.items.length > 20) return fail();
  const items = data.items.map(parseArchiveMetadata);
  let previous = before ? BigInt(before) : 9223372036854775808n;
  for (const item of items) { if (BigInt(item.id) >= previous) return fail(); previous = BigInt(item.id); }
  const cursor = data.nextBeforeId === undefined ? '' : archiveId(data.nextBeforeId);
  if (cursor && (!items.length || cursor !== items[items.length - 1].id)) return fail();
  return { items, nextBeforeId: cursor };
}
async function body(project: string, metadata: CalculationArchive, kind: 'input' | 'result' | 'provenance', signal: AbortSignal): Promise<unknown> {
  const response = await get(`${base(project)}/${metadata.id}/${kind}`, signal);
  const size = kind === 'provenance' ? metadata.provenanceBytes : kind === 'input' ? metadata.inputBytes : metadata.resultBytes;
  const digest = kind === 'provenance' ? metadata.provenanceSha256 : kind === 'input' ? metadata.inputSha256 : metadata.resultSha256;
  if (size === undefined || digest === undefined) return fail();
  if (response.headers.get('ETag') !== `"${digest}"` || response.headers.get('X-Enersy-Archive-Id') !== metadata.id || !response.body) return fail();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength; if (length > size) return fail(); chunks.push(next.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  signal.throwIfAborted(); if (length !== size) return fail();
  const content = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
}
export async function readCalculationArchive(project: string, id: string, signal: AbortSignal): Promise<OpenCalculationArchive> {
  const response = await get(`${base(project)}/${archiveId(id)}`, signal);
  const metadata = parseArchiveMetadata(await response.json()); signal.throwIfAborted(); if (metadata.id !== id) return fail();
  const values = await Promise.all([body(project, metadata, 'input', signal), body(project, metadata, 'result', signal)]);
  signal.throwIfAborted();
  const input = parseArchiveInput(values[0], metadata), result = parseCalculationResult(values[1]);
  requireSelectedBackend(result.solver, input.computeBackend);
  requireExecutionBudget(result.solver, input.executionOptions?.max_time_ms);
  requireOperatingLimits(result.operating_assessment, input.operatingLimits);
  const provenance = metadata.provenanceSha256 ? parseCalculationProvenance(await body(project, metadata, 'provenance', signal), input) : undefined;
  signal.throwIfAborted();
  if (result.method_used !== `${metadata.modelGroup}/${metadata.method}`) return fail();
  // Bind the result to the captured equipment, never to the currently open graph.
  const components = new Map(input.components.map(c => [c.id, c]));
  for (const t of result.topology?.terminals ?? []) if (components.get(t.component_id)?.type !== t.component_type) return fail();
  for (const b of result.branches ?? []) if (components.get(b.component_id)?.type !== b.code) return fail();
  for (const s of result.shunts ?? []) if (components.get(s.component_id)?.type !== s.code) return fail();
  for (const s of result.sources ?? []) if (components.get(s.component_id)?.type !== 'generator') return fail();
  return { metadata, input, result, ...(provenance ? { provenance } : {}) };
}
