import { parsePassportDocument, type PassportDocument } from '../domain/passport-document';
export { parsePassportDocument, type PassportDocument, type PassportParameter } from '../domain/passport-document';
import { archiveId } from './calculation-archives-api';
import { SessionError } from './projects-api';

export interface PassportVersion {
  id: string; projectId: string; authorAccountId: string; predecessorId: string | null;
  revision: number; status: 'draft'; sha256: string; createdAt: string; document: PassportDocument;
}
export interface PassportAttempt { commandId: string; predecessorId: string | null; document: PassportDocument }
const fail = (): never => { throw new Error('Некорректный ответ проектного каталога'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
export function parsePassportVersion(raw: unknown, project: string): PassportVersion {
  const v = record(raw);
  const id = archiveId(v.id), projectId = archiveId(v.projectId), authorAccountId = archiveId(v.authorAccountId);
  const predecessorId = v.predecessorId === null ? null : archiveId(v.predecessorId);
  if (projectId !== project || !Number.isInteger(v.revision) || typeof v.revision !== 'number' || v.revision < 1 || v.revision > 1000000 ||
      (v.revision === 1) !== (predecessorId === null) || (predecessorId !== null && BigInt(predecessorId) >= BigInt(id)) || v.status !== 'draft' ||
      typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256) || typeof v.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(v.createdAt) || !Number.isFinite(Date.parse(v.createdAt))) return fail();
  return { id, projectId, authorAccountId, predecessorId, revision: v.revision, status: 'draft', sha256: v.sha256, createdAt: v.createdAt,
    document: parsePassportDocument(v.document) };
}
function base(project: string) { return `/api/projects/${archiveId(project)}/passports`; }
async function request(url: string, signal: AbortSignal, attempt?: PassportAttempt): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(url, { method: attempt ? 'POST' : 'GET', signal, credentials: 'same-origin', cache: 'no-store',
    ...(attempt ? { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.commandId },
      body: JSON.stringify({ predecessorId: attempt.predecessorId, document: attempt.document }) } : {}) });
  signal.throwIfAborted();
  if (!response.ok) {
    const messages: Record<number, string> = { 400: 'Проверьте поля паспорта, значения и единицы параметров.', 401: 'Сессия недоступна.',
      404: 'Проект или паспорт недоступен.', 409: 'Версия, команда или квота каталога не позволяет сохранить паспорт. Обновите список.',
      413: 'Паспорт превышает допустимый размер.' };
    throw new SessionError(response.status, messages[response.status] ?? 'Сохранение или чтение каталога не подтверждено.');
  }
  const value: unknown = await response.json(); signal.throwIfAborted(); return value;
}
export async function listProjectPassports(project: string, signal: AbortSignal, after = '') {
  if (after) archiveId(after);
  const v = record(await request(`${base(project)}?limit=20${after ? `&afterId=${after}` : ''}`, signal));
  if (!Array.isArray(v.items) || v.items.length > 20) return fail();
  const items = v.items.map(raw => parsePassportVersion(raw, project));
  let previous = after || '0';
  for (const item of items) { if (BigInt(item.id) <= BigInt(previous)) return fail(); previous = item.id; }
  const nextAfterId = v.nextAfterId === undefined ? '' : archiveId(v.nextAfterId);
  if (nextAfterId && (!items.length || nextAfterId !== previous)) return fail();
  return { items, nextAfterId };
}
export async function readProjectPassport(project: string, id: string, signal: AbortSignal) {
  const v = parsePassportVersion(await request(`${base(project)}/${archiveId(id)}`, signal), project);
  if (v.id !== id) return fail(); return v;
}
function canonical(doc: PassportDocument) {
  return JSON.stringify({ ...doc, parameters: Object.fromEntries(Object.entries(doc.parameters).sort(([a], [b]) => a.localeCompare(b))) });
}
export async function saveProjectPassport(project: string, attempt: PassportAttempt, signal: AbortSignal) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attempt.commandId)) return fail();
  if (attempt.predecessorId !== null) archiveId(attempt.predecessorId);
  const snapshot = { ...attempt, document: parsePassportDocument(attempt.document) };
  const v = parsePassportVersion(await request(base(project), signal, snapshot), project);
  if (v.predecessorId !== snapshot.predecessorId || canonical(v.document) !== canonical(snapshot.document)) return fail();
  return v;
}
