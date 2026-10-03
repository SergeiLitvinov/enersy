import type { SchemeComponent } from '../../api/ees-api';
import type { ComponentPose } from './component-writes';
import { parseComponentRevision } from '../../api/component-revision';

export type ComponentIntent =
  | { kind: 'pose'; values: Partial<ComponentPose> }
  | { kind: 'parameter'; key: string; value: string }
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
});
const copyIntent = (intent: ComponentIntent): ComponentIntent => intent.kind === 'pose'
  ? { kind: 'pose', values: { ...intent.values } } : { ...intent };

/** App-lifetime recovery journal. Reload updates the server baseline, not failed intents. */
export class ComponentDrafts {
  private confirmed = new Map<string, SchemeComponent>();
  private pending = new Map<string, PendingDraft>();
  private reviews = new WeakMap<ComponentDraft, { key: string; base: SchemeComponent; intents: Map<object, ComponentIntent> }>();
  private key(schemeId: number, componentId: number) { return `${schemeId}:${componentId}`; }

  seed(schemeId: number, component: SchemeComponent) {
    this.confirmed.set(this.key(schemeId, component.id), copyComponent(component));
  }

  record(schemeId: number, component: SchemeComponent, intent: ComponentIntent) {
    const key = this.key(schemeId, component.id);
    let draft = this.pending.get(key);
    if (!draft) {
      draft = { schemeId, componentId: component.id, base: copyComponent(this.confirmed.get(key) ?? component), intents: new Map(), reason: '' };
      this.pending.set(key, draft);
    }
    const token = {};
    draft.intents.set(token, copyIntent(intent));
    return { key, token };
  }

  acknowledge(ticket: { key: string; token: object }, revision: string) {
    const draft = this.pending.get(ticket.key);
    const intent = draft?.intents.get(ticket.token);
    if (!draft || !intent) return;
    const previous = this.confirmed.get(ticket.key) ?? draft.base;
    if (intent.kind === 'delete') this.confirmed.delete(ticket.key);
    else {
      const next = copyComponent(previous);
      if (intent.kind === 'pose') Object.assign(next, intent.values);
      else next.params = { ...next.params, [intent.key]: intent.value };
      next.revision = revision;
      this.confirmed.set(ticket.key, next);
      // Confirmed edits become the base for remaining unacknowledged intents.
      draft.base = copyComponent(next);
    }
    draft.intents.delete(ticket.token);
    if (draft.intents.size === 0) this.pending.delete(ticket.key);
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
      (server.equipmentModelId ?? null) !== (draft.base.equipmentModelId ?? null)) {
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
      if (Object.prototype.hasOwnProperty.call(server.params, key)) {
        Object.defineProperty(draft.base.params, key, { value: server.params[key], enumerable: true, writable: true, configurable: true });
      } else delete draft.base.params[key];
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
