import type { Identity } from '../../api/projects-api';
import { draftId, draftRecord } from '../../api/editor-draft-payload';

type Kind = 'load-form' | 'parameter-form';
export type PrivateFormScope = Pick<Identity, 'accountId' | 'sessionId'> & { projectId: string; schemeId: string };
export interface PrivateFormStore<T> { read(componentId: number): T | null; save(componentId: number, value: T | null): void }
const prefix = (kind: Kind) => `enersy:${kind}:v1:`;
const problem = () => new Error('Не удалось сохранить или прочитать ввод формы в этой вкладке.');
export function exactFormRecord(raw: unknown, keys: readonly string[]) {
  const value = draftRecord(raw);
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw problem();
  return value;
}

/** Only local text recovery: no network, identity claims or permission grants. */
export function createPrivateFormJournal<T>(kind: Kind, scope: PrivateFormScope, signal: AbortSignal, parse: (raw: unknown) => T,
  storage: () => Storage = () => window.sessionStorage): PrivateFormStore<T> {
  const scopeKey = [draftId(scope.accountId, false), draftId(scope.sessionId, false), draftId(scope.projectId, false), draftId(scope.schemeId)].join(':');
  const key = (id: number) => {
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw problem();
    return `${prefix(kind)}${scopeKey}:${id}`;
  };
  return {
    read(id) {
      signal.throwIfAborted();
      const raw = storage().getItem(key(id));
      if (raw === null) return null;
      if (new TextEncoder().encode(raw).length > 64 * 1024) throw problem();
      const value = exactFormRecord(JSON.parse(raw), ['formatVersion', 'scope', 'componentId', 'value']);
      if (value.formatVersion !== 1 || value.scope !== scopeKey || value.componentId !== id) throw problem();
      return parse(value.value);
    },
    save(id, value) {
      signal.throwIfAborted();
      const store = storage(), name = key(id);
      if (value === null) {
        store.removeItem(name);
        if (store.getItem(name) !== null) throw problem();
        return;
      }
      const raw = JSON.stringify({ formatVersion: 1, scope: scopeKey, componentId: id, value: parse(value) });
      if (new TextEncoder().encode(raw).length > 64 * 1024) throw problem();
      let count = 0;
      for (let i = 0; i < store.length; i++) if (store.key(i)?.startsWith(prefix(kind))) count++;
      if (store.getItem(name) === null && count >= 128) throw new Error('Достигнут предел 128 сохранённых форм в этой вкладке.');
      store.setItem(name, raw);
      if (store.getItem(name) !== raw) throw problem();
    },
  };
}

export function forgetOtherPrivateFormSessions(kind: Kind, identity: Pick<Identity, 'accountId' | 'sessionId'> | null, storage: () => Storage = () => window.sessionStorage) {
  const keep = identity ? `${prefix(kind)}${identity.accountId}:${identity.sessionId}:` : '';
  try {
    const store = storage(), keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(prefix(kind)) && (!keep || !key.startsWith(keep))) keys.push(key);
    }
    keys.forEach(key => store.removeItem(key));
  } catch { /* Scope still prevents reading another identity's form. */ }
}
