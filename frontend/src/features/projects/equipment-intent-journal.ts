import type { Identity } from '../../api/projects-api';
import { draftId, draftRecord, encodeEditorDraftPayload, parseEditorDraftPayload, type EditorGraphIntent } from '../../api/editor-draft-payload';

type Scope = Pick<Identity, 'accountId' | 'sessionId'> & { projectId: string; schemeId: string };
type Intent = Extract<EditorGraphIntent, { kind: 'create-component' }>;
const prefix = 'enersy:equipment-intents:v1:';
const fail = (): never => { throw new Error('Локальный журнал создания недоступен или повреждён. Новые команды не отправляются.'); };

/** Tab-local write-ahead intentions, never credentials or evidence of access. */
export function createEquipmentIntentJournal(scope: Scope, storage: () => Storage = () => window.sessionStorage) {
  const captured = Object.freeze({ accountId: draftId(scope.accountId, false), sessionId: draftId(scope.sessionId, false),
    projectId: draftId(scope.projectId, false), schemeId: draftId(scope.schemeId) });
  const key = `${prefix}${captured.accountId}:${captured.sessionId}:${captured.projectId}:${captured.schemeId}`;
  function read(): Intent[] {
    const raw = storage().getItem(key);
    if (raw === null) return [];
    if (new TextEncoder().encode(raw).length > 260 * 1024) return fail();
    const value = draftRecord(JSON.parse(raw));
    if (!value || Object.keys(value).sort().join(',') !== 'payload,scope' || JSON.stringify(value.scope) !== JSON.stringify(captured)) return fail();
    const payload = parseEditorDraftPayload(value.payload);
    if (payload.components.length) return fail();
    return payload.graph.map(({ intent }) => {
      if (intent.kind !== 'create-component' || !intent.commandId || intent.expectedTopologyRevision === undefined) return fail();
      return intent;
    });
  }
  function save(intents: Intent[]) {
    const store = storage();
    if (!intents.length) {
      store.removeItem(key);
      if (store.getItem(key) !== null) return fail();
      return;
    }
    const payload: unknown = JSON.parse(encodeEditorDraftPayload({ formatVersion: 1, components: [], graph: intents.map(intent => ({ intent, reason: '' })) }));
    const body = JSON.stringify({ scope: captured, payload });
    let entries = 0;
    for (let i = 0; i < store.length; i++) if (store.key(i)?.startsWith(prefix)) entries++;
    if (store.getItem(key) === null && entries >= 32) throw new Error('Достигнут предел журналов создания в этой вкладке');
    store.setItem(key, body);
    if (store.getItem(key) !== body) return fail();
  }
  return { read,
    prepare(intent: Intent) {
      const checked = parseEditorDraftPayload({ formatVersion: 1, components: [], graph: [{ intent, reason: '' }] }).graph[0].intent;
      if (checked.kind !== 'create-component' || !checked.commandId || checked.expectedTopologyRevision === undefined) return fail();
      const current = read(), previous = current.find(item => item.commandId === checked.commandId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(checked)) throw new Error('Исходная команда создания уже записана с другими данными');
      save(previous ? current : [...current, checked]);
    },
    resolve(commandId: string) { save(read().filter(intent => intent.commandId !== commandId)); },
  };
}

export function forgetOtherEquipmentSessions(identity: Pick<Identity, 'accountId' | 'sessionId'> | null, storage: () => Storage = () => window.sessionStorage) {
  const keep = identity ? `${prefix}${identity.accountId}:${identity.sessionId}:` : '';
  try {
    const store = storage(), keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(prefix) && (!keep || !key.startsWith(keep))) keys.push(key);
    }
    keys.forEach(key => store.removeItem(key));
  } catch { /* Scope keys still isolate unavailable browser storage. */ }
}
