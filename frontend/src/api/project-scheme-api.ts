import { ComponentWriteError, componentRevisionHeaders, parseComponentRevision, parseCreatedComponent, readComponentWrite } from './component-revision';
import { calculationErrorMessage, parseCalculationResult, type ComponentPatch, type CalculationResult } from './ees-api';
import { archiveId } from './calculation-archives-api';
import { requireSelectedBackend, type ComputeBackendId } from './compute-backends';
import { isCalculationBudget, requireExecutionBudget } from './calculation-execution';
import { parseTerminalVoltageLimits, requireOperatingLimits, type TerminalVoltageLimit } from './operating-assessment';

/** Wire IDs/revisions remain strings. Conversion belongs only to the renderer adapter. */
export interface ProjectSchemeScope { projectId: string; schemeId: string }
export interface ProjectComponentInput {
  projectPassportVersionId?: string | null;
  typeId: string; equipmentModelId: string | null; x: number; y: number; rotation: number;
  name: string; params: Record<string, string>;
}
export interface ProjectCreatedComponent { success: true; id: string; revision: string; equipmentModelId: string | null; projectPassportVersionId?: string | null; params: Record<string, string> }
export interface ProjectConnectionInput { from: string; to: string; fromPort: string; toPort: string }
export interface ProjectConnectionAcknowledgement { success: true; id: string; commandId: string; deleted: boolean; topologyRevision: string }
export interface ProjectCalculation {
  result: CalculationResult;
  source: ProjectSchemeScope & { topologyRevision: string; inputSha256: string; archiveId?: string };
}

function id(value: string, graph = false): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 19 ||
      (value.length === 19 && value > '9223372036854775807') || (graph && BigInt(value) > 2147483647n)) {
    throw new Error('Некорректный ID проектной схемы');
  }
  return value;
}
function topology(value: unknown): string {
  if (value === '0') return value;
  return parseComponentRevision(value);
}
function path(scope: ProjectSchemeScope): string {
  return `/api/projects/${id(scope.projectId)}/schemes/${id(scope.schemeId, true)}`;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Сервер не подтвердил проектную команду');
  return value as Record<string, unknown>;
}
function etag(response: Response, revision: string): void {
  if (response.headers.get('ETag') !== `"${revision}"`) throw new Error('Ревизия ответа не совпадает с ETag');
}
async function send(url: string, method: string, signal: AbortSignal, headers: Record<string, string>, body?: unknown): Promise<Response> {
  signal.throwIfAborted();
  const response = await fetch(url, { method, signal, headers, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  signal.throwIfAborted();
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    signal.throwIfAborted();
    const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    throw new ComponentWriteError(calculationErrorMessage(data), response.status,
      typeof data.code === 'string' ? data.code : 'project_command_failed');
  }
  return response;
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  const value: unknown = await response.json();
  signal.throwIfAborted();
  return value;
}

export async function createProjectComponent(scope: ProjectSchemeScope, input: ProjectComponentInput, signal: AbortSignal): Promise<ProjectCreatedComponent> {
  const typeId = id(input.typeId, true);
  const equipmentModelId = input.equipmentModelId === null ? null : id(input.equipmentModelId, true);
  const passportId = input.projectPassportVersionId == null ? null : id(input.projectPassportVersionId);
  if (passportId !== null && equipmentModelId !== null) throw new Error('Выберите один источник паспорта');
  const response = await send(`${path(scope)}/components`, 'POST', signal, { 'Content-Type': 'application/json' }, { ...input, typeId, equipmentModelId });
  const data = record(await json(response, signal));
  const componentId = id(data.id as string, true);
  const modelId = data.equipmentModelId === null ? null : id(data.equipmentModelId as string, true);
  const confirmedPassport = data.projectPassportVersionId == null ? null : archiveId(data.projectPassportVersionId);
  if (confirmedPassport !== passportId) throw new Error('Сервер не подтвердил выбранную версию проектного паспорта');
  if (modelId !== equipmentModelId) throw new Error('Сервер не подтвердил выбранную паспортную модель');
  const parsed = parseCreatedComponent({ ...data, id: Number(componentId), equipmentModelId: modelId === null ? null : Number(modelId) });
  etag(response, parsed.revision);
  return { ...parsed, id: componentId, equipmentModelId: modelId, projectPassportVersionId: confirmedPassport };
}

async function componentWrite(scope: ProjectSchemeScope, componentId: string, method: string, revision: string, signal: AbortSignal, body?: unknown, suffix = '') {
  const response = await send(`${path(scope)}/components/${id(componentId, true)}${suffix}`, method, signal, componentRevisionHeaders(revision), body);
  const acknowledgement = await readComponentWrite(response);
  signal.throwIfAborted();
  etag(response, acknowledgement.revision);
  return acknowledgement;
}
export function updateProjectComponent(scope: ProjectSchemeScope, componentId: string, pose: { x: number; y: number; rotation: number; name: string }, revision: string, signal: AbortSignal) {
  return componentWrite(scope, componentId, 'PUT', revision, signal, pose);
}
export function patchProjectComponent(scope: ProjectSchemeScope, componentId: string, patch: ComponentPatch, revision: string, signal: AbortSignal) {
  return componentWrite(scope, componentId, 'PATCH', revision, signal, patch);
}
export function setProjectComponentParam(scope: ProjectSchemeScope, componentId: string, key: string, value: string, revision: string, signal: AbortSignal) {
  return componentWrite(scope, componentId, 'POST', revision, signal, { key, value }, '/params');
}
export function deleteProjectComponent(scope: ProjectSchemeScope, componentId: string, revision: string, signal: AbortSignal) {
  return componentWrite(scope, componentId, 'DELETE', revision, signal);
}

/** Keep the original command ID, payload and expected revision when retrying.
 * A deleted replay is an acknowledgement of history, never a new graph edge. */
export async function createProjectConnection(scope: ProjectSchemeScope, input: ProjectConnectionInput, commandId: string, expected: string, signal: AbortSignal): Promise<ProjectConnectionAcknowledgement> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(commandId)) throw new Error('Некорректный UUID команды');
  const response = await send(`${path(scope)}/connection-commands`, 'POST', signal,
    { 'Content-Type': 'application/json', 'If-Match': `"${topology(expected)}"`, 'Idempotency-Key': commandId },
    { ...input, from: id(input.from, true), to: id(input.to, true) });
  const data = record(await json(response, signal));
  if (data.success !== true || data.commandId !== commandId || typeof data.deleted !== 'boolean') throw new Error('Создание связи не подтверждено сервером');
  const topologyRevision = topology(data.topologyRevision);
  etag(response, topologyRevision);
  return { success: true, id: id(data.id as string, true), commandId, deleted: data.deleted, topologyRevision };
}
export async function deleteProjectConnection(scope: ProjectSchemeScope, connectionId: string, expected: string, signal: AbortSignal): Promise<{ success: true; topologyRevision: string }> {
  const response = await send(`${path(scope)}/connections/${id(connectionId, true)}`, 'DELETE', signal, { 'If-Match': `"${topology(expected)}"` });
  const data = record(await json(response, signal));
  if (data.success !== true) throw new Error('Удаление связи не подтверждено сервером');
  const topologyRevision = topology(data.topologyRevision);
  etag(response, topologyRevision);
  return { success: true, topologyRevision };
}
export async function calculateProjectScheme(scope: ProjectSchemeScope, expected: string, method: string, modelGroup: string, signal: AbortSignal, archive = false, backend?: ComputeBackendId, maxTimeMs?: number, operatingLimits?: readonly TerminalVoltageLimit[]): Promise<ProjectCalculation> {
  const limits = operatingLimits === undefined ? undefined : parseTerminalVoltageLimits(operatingLimits);
  if (maxTimeMs !== undefined && !isCalculationBudget(maxTimeMs)) throw new Error('Бюджет времени должен быть целым числом от 1 до 20000 мс');
  if (!method || !modelGroup) throw new Error('Выберите модель и метод расчёта');
  const revision = topology(expected);
  const response = await send(`${path(scope)}/${archive ? 'archive-calculation' : 'calculate'}?modelGroup=${encodeURIComponent(modelGroup)}&method=${encodeURIComponent(method)}${backend ? `&computeBackend=${encodeURIComponent(backend)}` : ''}${maxTimeMs === undefined ? '' : `&maxTimeMs=${maxTimeMs}`}`, 'POST', signal, { 'If-Match': `"${revision}"` }, limits === undefined ? undefined : {operatingLimits:limits});
  const data = await json(response, signal);
  if (data && typeof data === 'object' && 'success' in data && data.success === false) throw new Error(calculationErrorMessage(data));
  const inputSha256 = response.headers.get('X-Enersy-Input-SHA256');
  if (response.headers.get('X-Enersy-Project-Id') !== scope.projectId || response.headers.get('X-Enersy-Scheme-Id') !== scope.schemeId ||
      response.headers.get('X-Enersy-Topology-Revision') !== revision || !inputSha256 || !/^[0-9a-f]{64}$/.test(inputSha256)) {
    throw new Error('Сервер не подтвердил происхождение расчётного результата');
  }
  const saved = archive ? archiveId(response.headers.get('X-Enersy-Archive-Id')) : undefined;
  const result = parseCalculationResult(data);
  requireSelectedBackend(result.solver, backend);
  requireExecutionBudget(result.solver, maxTimeMs);
  requireOperatingLimits(result.operating_assessment, limits);
  return { result, source: { ...scope, topologyRevision: revision, inputSha256, ...(saved ? { archiveId: saved } : {}) } };
}
