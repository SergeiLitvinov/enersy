import type { Identity } from '../../api/projects-api';
import { draftId, draftRecord, EDITOR_DRAFT_MAX_BYTES } from '../../api/editor-draft-payload';
import { parseEditorDraftPayloadV2, type EditorDraftPayloadV2 } from '../../api/editor-draft-phases';

type Scope = Pick<Identity, 'accountId' | 'sessionId'> & { projectId: string; schemeId: string };
const prefix = 'enersy:component-intents:v1:';
const fail = (): never => { throw new Error('Локальный журнал правок недоступен или повреждён. Новые записи не отправляются.'); };

/** Write-ahead snapshots are tab-local recovery evidence, never an access grant. */
export function createComponentIntentJournal(scope: Scope, storage: () => Storage = () => window.sessionStorage) {
  const captured = Object.freeze({ accountId: draftId(scope.accountId, false), sessionId: draftId(scope.sessionId, false),
    projectId: draftId(scope.projectId, false), schemeId: draftId(scope.schemeId) });
  const key = `${prefix}${captured.accountId}:${captured.sessionId}:${captured.projectId}:${captured.schemeId}`;
  const empty = (): EditorDraftPayloadV2 => ({ formatVersion: 2, components: [], graph: [] });
  const checked = (raw: unknown) => {
    const payload = parseEditorDraftPayloadV2(raw);
    if (new TextEncoder().encode(JSON.stringify(payload)).length > EDITOR_DRAFT_MAX_BYTES) throw new Error('Журнал превышает предел 256 КиБ');
    return payload;
  };
  function read(): EditorDraftPayloadV2 {
    const raw = storage().getItem(key);
    if (raw === null) return empty();
    if (new TextEncoder().encode(raw).length > 260 * 1024) return fail();
    const value = draftRecord(JSON.parse(raw));
    if (Object.keys(value).sort().join(',') !== 'payload,scope' || JSON.stringify(value.scope) !== JSON.stringify(captured)) return fail();
    const payload = checked(value.payload);
    if (payload.graph.length) return fail();
    return payload;
  }
  function save(raw: unknown) {
    const payload = checked(raw);
    if (payload.graph.length) return fail();
    const store = storage();
    if (!payload.components.length) {
      store.removeItem(key);
      if (store.getItem(key) !== null) return fail();
      return;
    }
    const body = JSON.stringify({ scope: captured, payload });
    if (new TextEncoder().encode(body).length > 260 * 1024) return fail();
    let entries = 0;
    for (let i = 0; i < store.length; i++) if (store.key(i)?.startsWith(prefix)) entries++;
    if (store.getItem(key) === null && entries >= 32) throw new Error('Достигнут предел журналов правок в этой вкладке');
    store.setItem(key, body);
    if (store.getItem(key) !== body) return fail();
  }
  return { read, save };
}

export function forgetOtherComponentSessions(identity: Pick<Identity, 'accountId' | 'sessionId'> | null, storage: () => Storage = () => window.sessionStorage) {
  const keep = identity ? `${prefix}${identity.accountId}:${identity.sessionId}:` : '';
  try {
    const store = storage(), keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(prefix) && (!keep || !key.startsWith(keep))) keys.push(key);
    }
    keys.forEach(key => store.removeItem(key));
  } catch { /* A different identity still cannot read the old scoped key. */ }
}
