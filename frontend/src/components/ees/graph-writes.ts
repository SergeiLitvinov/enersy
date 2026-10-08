import type { SchemeComponent, SchemeConnection } from '../../api/ees-api';

export type GraphIntent =
  | { kind: 'create-component'; typeId: number; name: string; x: number; y: number; equipmentModelId: number | null }
  | { kind: 'create-connection'; commandId: string; from: number; to: number; fromPort: string; toPort: string }
  | { kind: 'delete-connection'; id: number };

export interface GraphFailure { id: number; intent: GraphIntent; reason: string }
export interface GraphSnapshot { id: number; components: SchemeComponent[]; connections: SchemeConnection[] }
export interface GraphReview { schemeId: number; failures: GraphFailure[]; server: GraphSnapshot }
const copyFailure = (failure: GraphFailure): GraphFailure => ({ ...failure, intent: { ...failure.intent } });
const copySnapshot = (snapshot: GraphSnapshot): GraphSnapshot => ({
  id: snapshot.id,
  components: snapshot.components.map(component => ({ ...component, params: { ...component.params } })),
  connections: snapshot.connections.map(connection => ({ ...connection, validationErrors: connection.validationErrors?.slice() })),
});

/** Dispatched graph mutations. A lost acknowledgement survives view reloads. */
export class GraphWrites {
  private pending = new Map<number, Set<Promise<void>>>();
  private errors = new Map<number, GraphFailure[]>();
  private schemeVersions = new Map<number, number>();
  private reviews = new WeakMap<GraphReview, { schemeId: number; version: number; failures: GraphFailure[]; server: GraphSnapshot }>();
  private nextFailureId = 1;
  private generation = 0;
  get version() { return this.generation; }
  versionFor(schemeId: number) { return this.schemeVersions.get(schemeId) ?? 0; }

  run<T>(schemeId: number, intent: GraphIntent, action: () => Promise<T>): Promise<T> {
    const captured = { ...intent };
    return this.track(schemeId, action, error => {
      const failures = this.errors.get(schemeId) ?? [];
      failures.push({ id: this.nextFailureId++, intent: captured, reason: error instanceof Error ? error.message : 'Подтверждение записи отсутствует' });
      this.errors.set(schemeId, failures);
    });
  }

  private track<T>(schemeId: number, action: () => Promise<T>, onFailure: (error: unknown) => void): Promise<T> {
    this.generation++;
    this.schemeVersions.set(schemeId, (this.schemeVersions.get(schemeId) ?? 0) + 1);
    const pending = this.pending.get(schemeId) ?? new Set<Promise<void>>();
    this.pending.set(schemeId, pending);
    const result = Promise.resolve().then(action);
    const settled = result.then(() => {}, onFailure).then(() => { pending.delete(settled); if (pending.size === 0) this.pending.delete(schemeId); });
    pending.add(settled);
    return result;
  }

  /** Retry exactly one reviewed creation through a protected transport.
   * The acknowledgement confirms the command, not the current topology.
   * Callers must read the server again before updating the displayed connections.
   */
  retryConnection(review: GraphReview, schemeId: number, failureId: number, isCurrent: () => boolean,
    action: (intent: Extract<GraphIntent, { kind: 'create-connection' }>) => Promise<{ id: number; success: boolean; commandId?: string }>,
    synchronize?: () => Promise<void>) {
    const captured = this.reviews.get(review);
    const failure = captured?.failures.find(item => item.id === failureId);
    if (!captured || captured.schemeId !== schemeId || captured.version !== this.schemeVersions.get(schemeId) ||
        this.pending.get(schemeId)?.size || !failure || !(this.errors.get(schemeId) ?? []).includes(failure) || !isCurrent()) {
      throw new Error('Сравнение устарело. Повторно сверьте исходную схему.');
    }
    if (failure.intent.kind !== 'create-connection' || !failure.intent.commandId) {
      throw new Error('Повтор поддержан только для создания связи с ключом команды');
    }
    const intent = { ...failure.intent };
    this.reviews.delete(review);
    return this.track(schemeId, async () => {
      if (!isCurrent()) throw new Error('Рабочий контекст изменился до отправки команды');
      const acknowledgement = await action({ ...intent });
      if (acknowledgement.success !== true || !Number.isSafeInteger(acknowledgement.id) || acknowledgement.id <= 0 ||
          acknowledgement.commandId !== intent.commandId.toLowerCase()) {
        throw new Error('Идентичность повторной команды не подтверждена');
      }
      // Keep the original intention and the calculation barrier until the view
      // has a fresh server topology. Failed reads can safely replay the same key.
      await synchronize?.();
      const remaining = (this.errors.get(schemeId) ?? []).filter(item => item !== failure);
      if (remaining.length) this.errors.set(schemeId, remaining); else this.errors.delete(schemeId);
      return acknowledgement;
    }, error => { failure.reason = error instanceof Error ? error.message : 'Повтор команды не подтверждён'; });
  }

  async settle(schemeId: number) {
    for (;;) {
      const pending = this.pending.get(schemeId);
      if (!pending?.size) return;
      await Promise.all([...pending]);
    }
  }

  failed(schemeId: number) { return (this.errors.get(schemeId) ?? []).map(copyFailure); }

  /** Read after dispatched writes settle. This is a comparison, never a retry. */
  async review(schemeId: number, read: () => Promise<GraphSnapshot>): Promise<GraphReview> {
    await this.settle(schemeId);
    const version = this.schemeVersions.get(schemeId) ?? 0;
    const failures = [...(this.errors.get(schemeId) ?? [])];
    if (!failures.length) throw new Error('Нет неподтверждённых изменений топологии');
    const server = await read();
    if (version !== this.schemeVersions.get(schemeId) || this.pending.get(schemeId)?.size) {
      throw new Error('Во время чтения появились изменения. Повторно сверьте топологию.');
    }
    if (server.id !== schemeId || !Array.isArray(server.components) || !Array.isArray(server.connections)) {
      throw new Error('Сервер не подтвердил полный состав исходной схемы');
    }
    const captured = copySnapshot(server);
    const review: GraphReview = { schemeId, failures: failures.map(copyFailure), server: copySnapshot(captured) };
    this.reviews.set(review, { schemeId, version, failures, server: captured });
    return review;
  }

  /** Explicitly abandon selected reviewed intents and use the read server topology.
   * This does not prove whether the original command ran and does not undo it.
   * It never removes unseen intentions or sends mutations to the server.
   */
  acceptServer(review: GraphReview, schemeId: number, selected: ReadonlySet<number>): GraphSnapshot {
    const captured = this.reviews.get(review);
    const failures = this.errors.get(schemeId) ?? [];
    if (!captured || captured.schemeId !== schemeId || captured.version !== this.schemeVersions.get(schemeId) ||
        this.pending.get(schemeId)?.size || captured.failures.some(failure => !failures.includes(failure))) {
      throw new Error('Сравнение устарело. Повторно сверьте исходную схему.');
    }
    if (!selected.size || [...selected].some(id => !captured.failures.some(failure => failure.id === id))) {
      throw new Error('Выберите рассмотренные изменения топологии');
    }
    const remaining = failures.filter(failure => !selected.has(failure.id));
    if (remaining.length) this.errors.set(schemeId, remaining);
    else this.errors.delete(schemeId);
    this.reviews.delete(review);
    return copySnapshot(captured.server);
  }

  assertConfirmed(schemeId: number) {
    if (this.errors.get(schemeId)?.length) {
      throw new Error('Изменение состава схемы или соединений не подтверждено. Расчёт заблокирован; требуется сверка сохранённой топологии.');
    }
  }
}
