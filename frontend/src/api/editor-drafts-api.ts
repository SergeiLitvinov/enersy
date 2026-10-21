import type { ProjectSchemeScope } from './project-scheme-api';
import { SessionError } from './projects-api';
import { draftId, draftRecord, draftRevision, draftUUID } from './editor-draft-payload';
import { encodeStoredEditorDraftPayload, parseStoredEditorDraftPayload, type StoredEditorDraftPayload } from './editor-draft-phases';

export interface EditorDraftMetadata { workspaceId: string; revision: string; updatedAt: string }
export interface StoredEditorDraft extends EditorDraftMetadata { payload: StoredEditorDraftPayload }
export class EditorDraftError extends SessionError {
  constructor(status: number, public code: string, message: string) { super(status, message); }
}
function path(scope: ProjectSchemeScope, workspaceId?: string): string {
  return `/api/projects/${draftId(scope.projectId, false)}/schemes/${draftId(scope.schemeId)}/drafts${workspaceId === undefined ? '' : `/${draftUUID(workspaceId)}`}`;
}
function metadata(value: unknown): EditorDraftMetadata {
  const item = draftRecord(value);
  if (typeof item.updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(item.updatedAt) ||
      !Number.isFinite(Date.parse(item.updatedAt))) throw new Error('Некорректное время журнала');
  return { workspaceId: draftUUID(item.workspaceId), revision: draftRevision(item.revision), updatedAt: item.updatedAt };
}
const messages: Record<number, string> = {
  400: 'Некорректный журнал или ревизия', 401: 'Сессия завершена', 404: 'Журнал или схема недоступны',
  409: 'Достигнут предел хранения журналов', 412: 'Журнал изменён другим контекстом. Сначала перечитайте его',
  413: 'Журнал превышает предел хранения', 428: 'Не указана исходная ревизия журнала', 503: 'Хранилище журналов временно недоступно',
};
/** Bound the actual streamed bytes, even without a trustworthy Content-Length.
 * Includes room for Go's HTML escaping of a 256 KiB payload. */
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const maxBytes = 2 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Пустой ответ хранилища журналов');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '', complete = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('Ответ хранилища журналов слишком велик');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    signal.throwIfAborted();
    const result: unknown = JSON.parse(text);
    complete = true;
    return result;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function send(url: string, method: string, signal: AbortSignal, revision?: string, body?: string): Promise<{ response: Response; data: unknown }> {
  signal.throwIfAborted();
  const response = await fetch(url, { method, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { Accept: 'application/json', ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body }) });
  if (signal.aborted) {
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    // Never reflect a server error body containing private values into the UI.
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    const codes: Record<number, string> = { 409: 'editor_draft_quota', 412: 'editor_draft_revision_conflict', 428: 'editor_draft_revision_required' };
    throw new EditorDraftError(response.status, codes[response.status] ?? 'editor_draft_request_failed',
      messages[response.status] ?? 'Не удалось выполнить запрос журнала');
  }
  if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => {});
    throw new Error('Хранилище не подтвердило JSON-ответ журнала');
  }
  return { response, data: await json(response, signal) };
}
function confirmed(response: Response, data: unknown, workspaceId: string): EditorDraftMetadata {
  const result = metadata(data);
  if (result.workspaceId !== workspaceId || response.headers.get('ETag') !== `"${result.revision}"`) {
    throw new Error('Хранилище не подтвердило контекст или ревизию журнала');
  }
  return result;
}
export async function listEditorDrafts(scope: ProjectSchemeScope, signal: AbortSignal): Promise<EditorDraftMetadata[]> {
  const { data } = await send(path(scope), 'GET', signal);
  const item = draftRecord(data);
  if (!Array.isArray(item.items) || item.items.length > 32) throw new Error('Некорректный список журналов');
  const seen = new Set<string>();
  return item.items.map(value => {
    const entry = draftRecord(value);
    if (Object.keys(entry).some(key => !['workspaceId', 'revision', 'updatedAt'].includes(key))) throw new Error('Список должен содержать только метаданные журналов');
    const result = metadata(entry);
    if (seen.has(result.workspaceId)) throw new Error('Повторный контекст в списке журналов');
    seen.add(result.workspaceId);
    return result;
  });
}
export async function readEditorDraft(scope: ProjectSchemeScope, workspaceId: string, signal: AbortSignal): Promise<StoredEditorDraft> {
  const { response, data } = await send(path(scope, workspaceId), 'GET', signal);
  const result = confirmed(response, data, workspaceId);
  return { ...result, payload: parseStoredEditorDraftPayload(draftRecord(data).payload) };
}
async function write(scope: ProjectSchemeScope, workspaceId: string, expected: string, signal: AbortSignal, body?: string): Promise<EditorDraftMetadata> {
  const revision = draftRevision(expected, body !== undefined);
  if (revision === '9223372036854775807') throw new Error('Исчерпан диапазон ревизий журнала');
  const { response, data } = await send(path(scope, workspaceId), body === undefined ? 'DELETE' : 'PUT', signal, revision, body);
  const result = confirmed(response, data, workspaceId);
  if (BigInt(result.revision) !== BigInt(revision) + 1n) throw new Error('Хранилище не подтвердило следующую ревизию журнала');
  return result;
}
/** One request only: conflict, lost acknowledgement and quota never cause retries.
 * A caller must reread before deciding whether a timed-out PUT was committed. */
export async function saveEditorDraft(scope: ProjectSchemeScope, workspaceId: string, expected: string, payload: StoredEditorDraftPayload, signal: AbortSignal): Promise<EditorDraftMetadata> {
  signal.throwIfAborted();
  return write(scope, workspaceId, expected, signal, encodeStoredEditorDraftPayload(payload));
}
export function deleteEditorDraft(scope: ProjectSchemeScope, workspaceId: string, expected: string, signal: AbortSignal): Promise<EditorDraftMetadata> {
  return write(scope, workspaceId, expected, signal);
}
