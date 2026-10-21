import type { SchemeComponent, SchemeConnection } from '../../api/ees-api';
import { parseEditorDraftPayload, type EditorGraphIntent } from '../../api/editor-draft-payload';
import { parseEditorDraftPayloadV2, type EditorGraphEntryV2 } from '../../api/editor-draft-phases';
import type { GraphDispatchCapture } from './scheme-transport';

export type GraphIntent =
  | { kind: 'create-component'; typeId: number; name: string; x: number; y: number; equipmentModelId: number | null; projectPassportVersionId?: string | null; rotation?: number; params?: Record<string, string> }
  | { kind: 'create-connection'; commandId: string; from: number; to: number; fromPort: string; toPort: string }
  | { kind: 'delete-connection'; id: number };

export interface GraphFailure { id: number; intent: GraphIntent; reason: string }
export interface GraphSnapshot { id: number; components: SchemeComponent[]; connections: SchemeConnection[] }
export interface GraphReview { schemeId: number; failures: GraphFailure[]; server: GraphSnapshot }
const copyIntent = (intent: GraphIntent): GraphIntent => intent.kind === 'create-component'
  ? { ...intent, ...(intent.params === undefined ? {} : { params: { ...intent.params } }) } : { ...intent };
const copyFailure = (failure: GraphFailure): GraphFailure => ({ ...failure, intent: copyIntent(failure.intent) });
const copyDispatch = (intent: EditorGraphIntent): EditorGraphIntent =>
  parseEditorDraftPayload({ formatVersion: 1, components: [], graph: [{ intent, reason: '' }] }).graph[0].intent;
type JournalEntry = { intent: GraphIntent; reason: string; dispatch?: EditorGraphIntent; restoredUnprepared?: boolean };
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
  private journal = new Map<number, Set<JournalEntry>>();
  private failureEntries = new WeakMap<GraphFailure, JournalEntry>();
  get version() { return this.generation; }
  versionFor(schemeId: number) { return this.schemeVersions.get(schemeId) ?? 0; }

  run<T>(schemeId: number, intent: GraphIntent, action: (capture: GraphDispatchCapture) => Promise<T>): Promise<T> {
    const captured = copyIntent(intent);
    const entry: JournalEntry = { intent: captured, reason: '' };
    const journal = this.journal.get(schemeId) ?? new Set<JournalEntry>();
    this.journal.set(schemeId, journal); journal.add(entry);
    let open = true;
    const capture: GraphDispatchCapture = wire => {
      if (!open) throw new Error('Попытка команды уже завершена');
      const copied = copyDispatch(wire);
      const matches = copied.kind === captured.kind && (copied.kind === 'create-connection' && captured.kind === 'create-connection'
        ? copied.commandId === captured.commandId && copied.from === String(captured.from) && copied.to === String(captured.to) && copied.fromPort === captured.fromPort && copied.toPort === captured.toPort
        : copied.kind === 'delete-connection' && captured.kind === 'delete-connection' ? copied.id === String(captured.id)
          : copied.kind === 'create-component' && captured.kind === 'create-component' && copied.typeId === String(captured.typeId) &&
            copied.name === captured.name && copied.x === captured.x && copied.y === captured.y && copied.rotation === captured.rotation &&
            copied.equipmentModelId === (captured.equipmentModelId === null ? null : String(captured.equipmentModelId)) &&
            (copied.projectPassportVersionId ?? null) === (captured.projectPassportVersionId ?? null) &&
            JSON.stringify(Object.entries(copied.params).sort()) === JSON.stringify(Object.entries(captured.params ?? {}).sort()));
      if (!matches || (entry.dispatch && JSON.stringify(entry.dispatch) !== JSON.stringify(copied))) throw new Error('Команда журнала не совпадает с отправляемым намерением');
      entry.dispatch = copied;
    };
    return this.track(schemeId, () => action(capture), error => {
      open = false;
      const failures = this.errors.get(schemeId) ?? [];
      const failure = { id: this.nextFailureId++, intent: captured, reason: error instanceof Error ? error.message : 'Подтверждение записи отсутствует' };
      entry.reason = failure.reason; this.failureEntries.set(failure, entry);
      failures.push(failure);
      this.errors.set(schemeId, failures);
    }, () => { open = false; journal.delete(entry); if (!journal.size) this.journal.delete(schemeId); });
  }

  private track<T>(schemeId: number, action: () => Promise<T>, onFailure: (error: unknown) => void, onSuccess?: () => void): Promise<T> {
    this.generation++;
    this.schemeVersions.set(schemeId, (this.schemeVersions.get(schemeId) ?? 0) + 1);
    const pending = this.pending.get(schemeId) ?? new Set<Promise<void>>();
    this.pending.set(schemeId, pending);
    const result = Promise.resolve().then(action);
    const settled = result.then(() => { onSuccess?.(); }, onFailure).then(() => { pending.delete(settled); if (pending.size === 0) this.pending.delete(schemeId); });
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
    if (this.failureEntries.get(failure)?.restoredUnprepared) {
      throw new Error('Исходная ревизия команды неизвестна. Примите серверную схему после сверки; новое соединение создавайте отдельным намерением.');
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
      const entry = this.failureEntries.get(failure);
      if (entry) this.journal.get(schemeId)?.delete(entry);
      if (!this.journal.get(schemeId)?.size) this.journal.delete(schemeId);
      if (remaining.length) this.errors.set(schemeId, remaining); else this.errors.delete(schemeId);
      return acknowledgement;
    }, error => {
      failure.reason = error instanceof Error ? error.message : 'Повтор команды не подтверждён';
      const entry = this.failureEntries.get(failure); if (entry) entry.reason = failure.reason;
    });
  }

  async settle(schemeId: number) {
    for (;;) {
      const pending = this.pending.get(schemeId);
      if (!pending?.size) return;
      await Promise.all([...pending]);
    }
  }

  failed(schemeId: number) { return (this.errors.get(schemeId) ?? []).map(copyFailure); }

  snapshot(schemeId: number): { intent: EditorGraphIntent; reason: string }[] {
    return [...(this.journal.get(schemeId) ?? [])].map(entry => {
      if (!entry.dispatch) throw new Error('Исходные данные структурной команды ещё не зафиксированы транспортом');
      return { intent: copyDispatch(entry.dispatch), reason: entry.reason };
    });
  }

  snapshotV2(schemeId: number): EditorGraphEntryV2[] {
    const graph = [...(this.journal.get(schemeId) ?? [])].map(entry => {
      if (entry.dispatch) return { phase: 'prepared', intent: entry.dispatch, reason: entry.reason };
      const i = entry.intent;
      const intent = i.kind === 'create-component' ? { ...i, typeId: String(i.typeId), equipmentModelId: i.equipmentModelId === null ? null : String(i.equipmentModelId) }
        : i.kind === 'create-connection' ? { ...i, from: String(i.from), to: String(i.to) } : { ...i, id: String(i.id) };
      return { phase: 'unprepared', intent, reason: entry.reason };
    });
    return parseEditorDraftPayloadV2({ formatVersion: 2, components: [], graph }).graph;
  }

  restore(schemeId: number, entries: readonly EditorGraphEntryV2[]) {
    if (this.generation || this.journal.size) throw new Error('Восстанавливайте журнал в новой очереди');
    const checked = parseEditorDraftPayloadV2({ formatVersion: 2, components: [], graph: entries }).graph;
    const journal = new Set<JournalEntry>(), failures: GraphFailure[] = [];
    for (const item of checked) {
      const wire = item.intent;
      const intent: GraphIntent = wire.kind === 'create-component' ? { ...wire, typeId: Number(wire.typeId), equipmentModelId: wire.equipmentModelId === null ? null : Number(wire.equipmentModelId), params: { ...wire.params } }
        : wire.kind === 'create-connection' ? { kind: wire.kind, commandId: wire.commandId, from: Number(wire.from), to: Number(wire.to), fromPort: wire.fromPort, toPort: wire.toPort }
          : { kind: wire.kind, id: Number(wire.id) };
      const entry: JournalEntry = { intent,
        ...(item.phase === 'prepared' ? { dispatch: copyDispatch(item.intent) } : { restoredUnprepared: true }),
        reason: item.reason || 'Восстановленная команда требует сверки с сервером' };
      const failure = { id: this.nextFailureId++, intent, reason: entry.reason };
      journal.add(entry); failures.push(failure); this.failureEntries.set(failure, entry);
    }
    if (journal.size) { this.journal.set(schemeId, journal); this.errors.set(schemeId, failures); this.generation++; this.schemeVersions.set(schemeId, 1); }
  }

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
    for (const failure of failures.filter(failure => selected.has(failure.id))) {
      const entry = this.failureEntries.get(failure); if (entry) this.journal.get(schemeId)?.delete(entry);
    }
    if (!this.journal.get(schemeId)?.size) this.journal.delete(schemeId);
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
