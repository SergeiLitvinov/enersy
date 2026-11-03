import type { SchemeComponent } from '../../api/ees-api';
import type { ComponentPose } from './component-writes';
import { parseComponentRevision } from '../../api/component-revision';
import { copyParameterUnits, mergeParameterUnits, parameterSourceBase } from '../../api/parameter-unit-declaration';
import { sameParameterBase, type ParameterBase } from '../../domain/parameter-base';

export type ComponentIntent =
  | { kind: 'pose'; values: Partial<ComponentPose> }
  | { kind: 'parameter'; key: string; value: string; unit?: string; base?: ParameterBase | null }
  | { kind: 'delete' };

export interface ComponentDraft {
  schemeId: number;
  componentId: number;
  base: SchemeComponent;
  intents: ComponentIntent[];
  reason: string;
}

type PendingDraft = Omit<ComponentDraft, 'intents'> & { intents: Map<object, ComponentIntent> };
const copyComponent = (component: SchemeComponent): SchemeComponent => ({
  id: component.id, revision: component.revision, type: component.type, typeId: component.typeId,
  name: component.name, x: component.x, y: component.y, rotation: component.rotation,
  equipmentModelId: component.equipmentModelId, params: { ...component.params },
  ...(component.declaredParameterUnits ? { declaredParameterUnits: copyParameterUnits(component.declaredParameterUnits) } : {}),
  ...(component.projectPassportVersionId == null ? {} : { projectPassportVersionId: component.projectPassportVersionId }),
});
const copyIntent = (intent: ComponentIntent): ComponentIntent => intent.kind === 'pose'
  ? { kind: 'pose', values: { ...intent.values } } : intent.kind === 'parameter' && intent.base ? { ...intent, base: { ...intent.base } } : { ...intent };

function changedParameterContext(before: SchemeComponent, after: SchemeComponent, key: string): boolean {
  const unit = (component: SchemeComponent) => {
    const units = component.declaredParameterUnits?.units;
    return units && Object.prototype.hasOwnProperty.call(units, key) ? units[key] : undefined;
  };
  return unit(before) !== unit(after) || !sameParameterBase(parameterSourceBase(before.declaredParameterUnits, key), parameterSourceBase(after.declaredParameterUnits, key));
}

/** App-lifetime recovery journal. Reload updates the server baseline, not failed intents. */
export class ComponentDrafts {
  private confirmed = new Map<string, SchemeComponent>();
  private pending = new Map<string, PendingDraft>();
  private reviews = new WeakMap<ComponentDraft, { key: string; base: SchemeComponent; intents: Map<object, ComponentIntent> }>();
  private key(schemeId: number, componentId: number) { return `${schemeId}:${componentId}`; }

  /** Include in-flight intentions; only an acknowledgement may remove them. */
  snapshot(schemeId: number): ComponentDraft[] {
    return [...this.pending.values()].filter(draft => draft.schemeId === schemeId).map(draft => ({
      schemeId, componentId: draft.componentId, base: copyComponent(draft.base),
      intents: [...draft.intents.values()].map(copyIntent), reason: draft.reason,
    }));
  }

  /** Fresh journals only. Imported intentions are evidence, never queued actions. */
  restore(schemeId: number, snapshots: readonly ComponentDraft[]) {
    if (this.pending.size || this.confirmed.size) throw new Error('Восстанавливайте журнал в новом рабочем контексте');
    const entries = new Map<string, PendingDraft>();
    for (const draft of snapshots) {
      const key = this.key(schemeId, draft.componentId);
      if (draft.schemeId !== schemeId || entries.has(key) || draft.base.id !== draft.componentId || !draft.intents.length) {
        throw new Error('Некорректный контекст журнала оборудования');
      }
      parseComponentRevision(draft.base.revision);
      entries.set(key, { schemeId, componentId: draft.componentId, base: copyComponent(draft.base),
        intents: new Map(draft.intents.map(intent => [{}, copyIntent(intent)])),
        reason: draft.reason || 'Восстановленное намерение требует сверки с сервером' });
    }
    this.pending = entries;
  }

  seed(schemeId: number, component: SchemeComponent) {
    this.confirmed.set(this.key(schemeId, component.id), copyComponent(component));
  }

  hasParameterContextChanged(schemeId: number, component: SchemeComponent, keys: readonly string[]): boolean {
    const confirmed = this.confirmed.get(this.key(schemeId, component.id));
    return !!confirmed && keys.some(key => changedParameterContext(component, confirmed, key));
  }

  record(schemeId: number, component: SchemeComponent, intent: ComponentIntent, capturedBase = false) {
    const key = this.key(schemeId, component.id);
    let draft = this.pending.get(key);
    if (!draft) {
      draft = { schemeId, componentId: component.id, base: copyComponent(capturedBase ? component : this.confirmed.get(key) ?? component), intents: new Map(), reason: '' };
      this.pending.set(key, draft);
    }
    const token = {};
    draft.intents.set(token, copyIntent(intent));
    return { key, token };
  }

  acknowledge(ticket: { key: string; token: object }, revision: string) {
    this.acknowledgeBatch([ticket], revision);
  }

  /** One server commit is applied as a whole before rebasing remaining work. */
  acknowledgeBatch(tickets: readonly { key: string; token: object }[], revision: string) {
    const groups = new Map<string, Set<object>>();
    for (const ticket of tickets) {
      const tokens = groups.get(ticket.key) ?? new Set<object>();
      tokens.add(ticket.token); groups.set(ticket.key, tokens);
    }
    for (const [key, tokens] of groups) {
      const draft = this.pending.get(key);
      if (!draft) continue;
      const applied = [...tokens].flatMap(token => { const intent = draft.intents.get(token); return intent ? [intent] : []; });
      if (!applied.length) continue;
      if (applied.some(intent => intent.kind === 'delete')) this.confirmed.delete(key);
      else {
        const previous = this.confirmed.get(key) ?? draft.base;
        const next = copyComponent(previous);
        for (const intent of applied) {
          if (intent.kind === 'pose') Object.assign(next, intent.values);
          else if (intent.kind === 'parameter') {
            next.params = { ...next.params, [intent.key]: intent.value };
            if (intent.unit !== undefined) next.declaredParameterUnits = mergeParameterUnits(next.declaredParameterUnits, {
              formatVersion: Object.prototype.hasOwnProperty.call(intent, 'base') ? 2 : 1, units: { [intent.key]: intent.unit },
              ...(Object.prototype.hasOwnProperty.call(intent, 'base') ? { bases: { [intent.key]: intent.base ?? null } } : {}),
            });
          }
        }
        next.revision = revision;
        this.confirmed.set(key, next);
        const changedKeys = new Set(applied.flatMap(intent => intent.kind === 'parameter' &&
          changedParameterContext(previous, next, intent.key) ? [intent.key] : []));
        const contextChanged = changedKeys.size > 0 && [...draft.intents].some(([token, intent]) => !tokens.has(token) && intent.kind === 'parameter' && changedKeys.has(intent.key) &&
          changedParameterContext(draft.base, next, intent.key));
        // A queued coefficient belongs to its captured representation. Updating
        // its baseline here would hide an intervening unit/basis change.
        if (contextChanged && !draft.reason) draft.reason = 'Единица или исходный базис изменились при подтверждении предыдущей записи. Сверьте оставшиеся параметры перед повтором.';
        if (!draft.reason) draft.base = copyComponent(next);
      }
      for (const token of tokens) draft.intents.delete(token);
      if (draft.intents.size === 0) this.pending.delete(key);
    }
  }

  fail(ticket: { key: string; token: object }, reason: string) {
    const draft = this.pending.get(ticket.key);
    if (draft && draft.intents.has(ticket.token) && !draft.reason) draft.reason = reason;
  }

  cancel(ticket: { key: string; token: object }) {
    const draft = this.pending.get(ticket.key);
    if (!draft) return;
    draft.intents.delete(ticket.token);
    if (draft.intents.size === 0) this.pending.delete(ticket.key);
  }

  failed(schemeId: number): ComponentDraft[] {
    return [...this.pending.entries()].filter(([, draft]) => draft.schemeId === schemeId && draft.reason !== '').map(([key, draft]) => {
      const snapshot: ComponentDraft = {
        schemeId: draft.schemeId, componentId: draft.componentId, reason: draft.reason,
        base: copyComponent(draft.base), intents: [...draft.intents.values()].map(copyIntent),
      };
      this.reviews.set(snapshot, { key, base: draft.base, intents: new Map(draft.intents) });
      return snapshot;
    });
  }

  /** Check immediately before dispatch; a changed journal must be compared again. */
  isCurrentReview(snapshot: ComponentDraft): boolean {
    const review = this.reviews.get(snapshot);
    const draft = review && this.pending.get(review.key);
    return Boolean(review && draft && draft.base === review.base && draft.intents.size === review.intents.size &&
      [...review.intents].every(([token, intent]) => draft.intents.get(token) === intent));
  }

  hasReviewedDeletion(snapshot: ComponentDraft): boolean {
    const review = this.reviews.get(snapshot);
    return Boolean(review && [...review.intents.values()].some(intent => intent.kind === 'delete'));
  }

  /** Resolve only reviewed fields after a confirmed write or explicit server acceptance.
   * New intents recorded while the request was in flight are never removed.
   * The caller must supply the exact acknowledged server state, not optimistic UI state.
   */
  resolveReviewed(snapshot: ComponentDraft, selected: ReadonlySet<string>, server: SchemeComponent): boolean {
    const review = this.reviews.get(snapshot);
    if (!review) throw new Error('Повторно откройте сравнение правок');
    const draft = this.pending.get(review.key);
    if (!draft) return false;
    if (server.id !== draft.componentId || server.type !== draft.base.type || server.typeId !== draft.base.typeId ||
      (server.equipmentModelId ?? null) !== (draft.base.equipmentModelId ?? null) ||
      (server.projectPassportVersionId ?? null) !== (draft.base.projectPassportVersionId ?? null)) {
      throw new Error('Объект или его паспорт изменился. Повторно сравните оборудование.');
    }
    parseComponentRevision(server.revision);
    const fields = new Set<string>();
    for (const intent of review.intents.values()) {
      if (intent.kind === 'parameter') fields.add(`parameter:${intent.key}`);
      else if (intent.kind === 'pose') Object.keys(intent.values).forEach(field => fields.add(`pose:${field}`));
    }
    if (!selected.size || [...selected].some(field => !fields.has(field))) {
      throw new Error('Выберите рассмотренные поля; удаление разрешается отдельно');
    }
    let resolved = false;
    for (const [token, intent] of review.intents) {
      if (draft.intents.get(token) !== intent) continue;
      if (intent.kind === 'parameter' && selected.has(`parameter:${intent.key}`)) {
        draft.intents.delete(token);
        resolved = true;
      } else if (intent.kind === 'pose') {
        const values = { ...intent.values };
        for (const field of ['x', 'y', 'rotation', 'name'] as const) {
          if (selected.has(`pose:${field}`) && Object.prototype.hasOwnProperty.call(values, field)) {
            delete values[field];
            resolved = true;
          }
        }
        if (Object.keys(values).length !== Object.keys(intent.values).length) {
          if (Object.keys(values).length === 0) draft.intents.delete(token);
          else draft.intents.set(token, { kind: 'pose', values });
        }
      }
    }
    if (!resolved) return false;
    this.confirmed.set(review.key, copyComponent(server));
    // Preserve the original baseline for fields that have not been reviewed.
    draft.base = copyComponent(draft.base);
    for (const field of ['x', 'y', 'rotation', 'name'] as const) {
      if (selected.has(`pose:${field}`)) Object.assign(draft.base, { [field]: server[field] });
    }
    for (const field of selected) {
      if (!field.startsWith('parameter:')) continue;
      const key = field.slice('parameter:'.length);
      // An intent added during the request still belongs to the original value/unit pair.
      const originalUnit = draft.base.declaredParameterUnits && Object.prototype.hasOwnProperty.call(draft.base.declaredParameterUnits.units, key)
        ? draft.base.declaredParameterUnits.units[key] : undefined;
      const serverUnit = server.declaredParameterUnits && Object.prototype.hasOwnProperty.call(server.declaredParameterUnits.units, key)
        ? server.declaredParameterUnits.units[key] : undefined;
      if ((originalUnit !== serverUnit || !sameParameterBase(parameterSourceBase(draft.base.declaredParameterUnits, key), parameterSourceBase(server.declaredParameterUnits, key))) && [...draft.intents.values()].some(intent => intent.kind === 'parameter' && intent.key === key)) continue;
      if (Object.prototype.hasOwnProperty.call(server.params, key)) {
        Object.defineProperty(draft.base.params, key, { value: server.params[key], enumerable: true, writable: true, configurable: true });
      } else delete draft.base.params[key];
      const units = { ...draft.base.declaredParameterUnits?.units };
      if (server.declaredParameterUnits && Object.prototype.hasOwnProperty.call(server.declaredParameterUnits.units, key)) {
        Object.defineProperty(units, key, { value: server.declaredParameterUnits.units[key], enumerable: true, writable: true, configurable: true });
      } else delete units[key];
      const bases = copyParameterUnits(draft.base.declaredParameterUnits ?? { formatVersion: 1, units: {} }).bases ?? {};
      const serverBase = parameterSourceBase(server.declaredParameterUnits, key);
      if (serverBase) Object.defineProperty(bases, key, { value: { ...serverBase }, enumerable: true, writable: true, configurable: true });
      else delete bases[key];
      if (Object.keys(units).length) draft.base.declaredParameterUnits = Object.keys(bases).length ? { formatVersion: 2, units, bases } : { formatVersion: 1, units };
      else delete draft.base.declaredParameterUnits;
    }
    // Baseline values may originate in different revisions until all fields are resolved.
    if (draft.intents.size === 0) this.pending.delete(review.key);
    return true;
  }

  hasFailed(schemeId: number, componentId?: number) {
    if (componentId !== undefined) return Boolean(this.pending.get(this.key(schemeId, componentId))?.reason);
    return [...this.pending.values()].some(draft => draft.schemeId === schemeId && draft.reason !== '');
  }

  /** Resolve reviewed deletion intents only; edits to a missing object stay recoverable. */
  resolveDeletion(snapshot: ComponentDraft, server?: SchemeComponent): boolean {
    const review = this.reviews.get(snapshot);
    if (!review) throw new Error('Повторно откройте сравнение правок');
    const draft = this.pending.get(review.key);
    if (!draft) return false;
    if (server) {
      if (server.id !== draft.componentId) throw new Error('Сравнивается другое оборудование');
      parseComponentRevision(server.revision);
    }
    let resolved = false;
    for (const [token, intent] of review.intents) {
      if (intent.kind === 'delete' && draft.intents.get(token) === intent) {
        draft.intents.delete(token);
        resolved = true;
      }
    }
    if (!resolved) throw new Error('В рассмотренном журнале нет неподтверждённого удаления');
    if (server) this.confirmed.set(review.key, copyComponent(server));
    else this.confirmed.delete(review.key);
    if (!draft.intents.size) this.pending.delete(review.key);
    return true;
  }

  discard(schemeId: number, componentId: number) { this.pending.delete(this.key(schemeId, componentId)); }
  resetBaseline() { this.confirmed.clear(); }
}
