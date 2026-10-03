/** Lossless PostgreSQL BIGINT tokens; never convert these revisions to Number. */
export function parseComponentRevision(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !/^[1-9][0-9]{0,18}$/.test(value) ||
    (value.length === 19 && value > '9223372036854775807')) {
    throw new Error('Сервер вернул некорректную ревизию оборудования. Повторно загрузите схему.');
  }
  return value;
}

export interface ComponentWriteResult { success: true; revision: string }
export interface CreatedComponent extends ComponentWriteResult {
  id: number;
  params: Record<string, string>;
  equipmentModelId: number | null;
}

export function parseCreatedComponent(value: unknown): CreatedComponent {
  if (typeof value !== 'object' || value === null) throw new Error('Некорректный ответ создания оборудования');
  const record = value as Record<string, unknown>;
  if (record.success !== true || !Number.isSafeInteger(record.id) || typeof record.id !== 'number' || record.id <= 0 ||
    (record.equipmentModelId !== null && (typeof record.equipmentModelId !== 'number' || !Number.isSafeInteger(record.equipmentModelId) || record.equipmentModelId <= 0)) ||
    typeof record.params !== 'object' || record.params === null || Array.isArray(record.params)) {
    throw new Error('Сервер не подтвердил создание оборудования. Повторно загрузите схему.');
  }
  const params: Record<string, string> = {};
  for (const [key, parameter] of Object.entries(record.params)) {
    if (typeof parameter !== 'string') throw new Error('Некорректные параметры созданного оборудования');
    Object.defineProperty(params, key, { value: parameter, enumerable: true, writable: true, configurable: true });
  }
  return { id: record.id, success: true, revision: parseComponentRevision(record.revision), params, equipmentModelId: record.equipmentModelId };
}

export class ComponentWriteError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'ComponentWriteError';
  }
}

export async function readComponentWrite(response: Response): Promise<ComponentWriteResult> {
  const value: unknown = await response.json().catch(() => null);
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  if (!response.ok) {
    throw new ComponentWriteError(typeof record.error === 'string' ? record.error : 'Не удалось подтвердить сохранение оборудования. Повторно загрузите схему.',
      response.status, typeof record.code === 'string' ? record.code : 'component_write_failed');
  }
  if (record.success !== true) throw new Error('Сервер не подтвердил сохранение оборудования. Повторно загрузите схему.');
  return { success: true, revision: parseComponentRevision(record.revision) };
}

export function componentRevisionHeaders(revision: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'If-Match': `"${parseComponentRevision(revision)}"` };
}
