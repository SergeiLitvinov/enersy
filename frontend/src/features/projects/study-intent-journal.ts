import { appendStudyVersion, createStudy, parseStudyDocument, type StudyDocument } from '../../api/studies-api';
import type { Identity } from '../../api/projects-api';

export type StudyIntentScope = Pick<Identity, 'accountId' | 'sessionId'> & { projectId: string };
export type StudyIntent = { formatVersion: 1; projectId: string; schemeId: string; command: string; topology: string; document: StudyDocument; studyId?: string; expected?: string };
const prefix = 'enersy:study-intent:v1:';
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const revision = (v: unknown) => v === '0' || id(v);
const fail = (): never => { throw new Error('Локальная запись команды Study недоступна или повреждена. Запись на сервер не отправлена.'); };
export function parseStudyIntent(raw: unknown, project: string): StudyIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const v = raw as Record<string, unknown>;
  if (v.formatVersion !== 1 || !id(project) || v.projectId !== project || !id(v.schemeId) || BigInt(v.schemeId) > 2147483647n || !revision(v.topology) ||
      typeof v.command !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.command) ||
      Object.keys(v).some(k => !['formatVersion', 'projectId', 'schemeId', 'command', 'topology', 'document', 'studyId', 'expected'].includes(k)) ||
      ((v.studyId !== undefined || v.expected !== undefined) && (!id(v.studyId) || !id(v.expected) || BigInt(v.expected) >= 9223372036854775807n))) return fail();
  return { formatVersion: 1, projectId: project, schemeId: v.schemeId, command: v.command, topology: v.topology as string, document: parseStudyDocument(v.document),
    ...(v.studyId === undefined ? {} : { studyId: v.studyId as string, expected: v.expected as string }) };
}
/** One pending command per project in this tab. It is an intention, never a network snapshot or proof of access. */
export function createStudyIntentJournal(scope: StudyIntentScope, storage: () => Storage = () => window.sessionStorage) {
  if (![scope.accountId, scope.sessionId, scope.projectId].every(id)) return fail();
  const captured = Object.freeze({ ...scope }), key = `${prefix}${scope.accountId}:${scope.sessionId}:${scope.projectId}`;
  const read = (): StudyIntent | null => {
    const raw = storage().getItem(key);
    if (raw === null) return null;
    if (new TextEncoder().encode(raw).length > 128 * 1024) return fail();
    return parseStudyIntent(JSON.parse(raw), captured.projectId);
  };
  return { scope: captured, read,
    prepare(value: StudyIntent) {
      const intent = parseStudyIntent(value, captured.projectId), body = JSON.stringify(intent), previous = read();
      if (previous && JSON.stringify(previous) !== body) throw new Error('Сначала проверьте исход прежней команды Study. Новый идентификатор не заменяет неподтверждённую запись.');
      if (new TextEncoder().encode(body).length > 128 * 1024) return fail();
      // Bound the tab-wide journal, including projects that are not currently selected.
      const store = storage(); let entries = 0;
      for (let i = 0; i < store.length; i++) if (store.key(i)?.startsWith(prefix)) entries++;
      if (!previous && entries >= 32) throw new Error('Достигнут предел локальных команд Study. Проверьте прежние команды в проектах.');
      store.setItem(key, body);
      if (store.getItem(key) !== body) return fail();
    },
    clear(command: string) {
      const previous = read();
      if (previous && previous.command !== command) return fail();
      storage().removeItem(key);
      if (storage().getItem(key) !== null) return fail();
    },
    discard() { storage().removeItem(key); if (storage().getItem(key) !== null) return fail(); },
  };
}
export type StudyIntentJournal = ReturnType<typeof createStudyIntentJournal>;
export function executeStudyIntent(intent: StudyIntent, scope: StudyIntentScope, signal: AbortSignal) {
  const v = parseStudyIntent(intent, scope.projectId);
  return v.studyId === undefined
    ? createStudy(v.projectId, v.schemeId, v.topology, v.document, v.command, signal, scope)
    : appendStudyVersion(v.projectId, v.studyId, v.expected!, v.topology, v.document, v.command, signal, scope);
}
/** Logout and an observed identity switch clear only this feature's tab-local values. No session token is stored. */
export function forgetOtherStudySessions(identity: Pick<Identity, 'accountId' | 'sessionId'> | null, storage: () => Storage = () => window.sessionStorage) {
  const keep = identity ? `${prefix}${identity.accountId}:${identity.sessionId}:` : '';
  try {
    const store = storage(), keys: string[] = [];
    for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k?.startsWith(prefix) && (!keep || !k.startsWith(keep))) keys.push(k); }
    keys.forEach(k => store.removeItem(k));
  } catch { /* An unavailable storage remains inaccessible; scope keys still prevent cross-identity recovery. */ }
}
