import type { ComponentPatch, SchemeComponent } from '../../api/ees-api';
import { parseComponentRevision, type ComponentWriteResult } from '../../api/component-revision';
import { ComponentDrafts, type ComponentDraft, type ComponentIntent } from './component-drafts';
import { prepareRecoveryPatch } from './component-comparison';

export type ComponentPose = Pick<SchemeComponent, 'x' | 'y' | 'rotation' | 'name'>;

/** FIFO per object. Recovery keeps failed intents until explicit resolution and a fresh load. */
export class ComponentWrites {
  readonly drafts = new ComponentDrafts();
  private entries = new Map<number, { tail: Promise<void>; failed: boolean; deleted?: boolean; revision: string; pose?: ComponentPose }>();

  private entry(component: Pick<SchemeComponent, 'id' | 'revision'>) {
    const { id } = component;
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { tail: Promise.resolve(), failed: false, revision: parseComponentRevision(component.revision) };
      this.entries.set(id, entry);
    }
    return entry;
  }

  seed(schemeId: number, component: SchemeComponent) {
    this.drafts.seed(schemeId, component);
    const entry = this.entry(component);
    entry.revision = parseComponentRevision(component.revision);
    entry.pose = { x: component.x, y: component.y, rotation: component.rotation, name: component.name };
    entry.failed = this.drafts.hasFailed(schemeId, component.id);
    entry.deleted = false;
  }

  run<T extends ComponentWriteResult>(component: SchemeComponent, isCurrent: () => boolean, action: (revision: string) => Promise<T>,
    recovery?: { schemeId: number; intent: ComponentIntent }): Promise<T | undefined> {
    const entry = this.entry(component);
    const ticket = recovery ? this.drafts.record(recovery.schemeId, component, recovery.intent) : undefined;
    const result = entry.tail.then(async () => {
      if (!isCurrent()) { if (ticket) this.drafts.cancel(ticket); return undefined; }
      try {
        if (entry.failed || entry.deleted || (recovery && this.drafts.hasFailed(recovery.schemeId, component.id))) {
          throw new Error('Состояние оборудования не подтверждено. Повторно загрузите схему и разрешите конфликт.');
        }
        const result = await action(entry.revision);
        entry.revision = parseComponentRevision(result.revision);
        if (recovery?.intent.kind === 'delete') entry.deleted = true;
        if (ticket) this.drafts.acknowledge(ticket, entry.revision);
        return result;
      }
      catch (error) {
        entry.failed = true;
        if (ticket) this.drafts.fail(ticket, error instanceof Error ? error.message : 'Сохранение не подтверждено');
        throw error;
      }
    });
    // Preserve failure for each caller without leaving an unhandled queue tail.
    entry.tail = result.then(() => {}, () => {});
    return result;
  }

  pose(component: SchemeComponent, change: (pose: ComponentPose) => ComponentPose,
    isCurrent: () => boolean, write: (pose: ComponentPose, revision: string) => Promise<ComponentWriteResult>, schemeId?: number) {
    const entry = this.entry(component);
    const previous = entry.pose ?? { x: component.x, y: component.y, rotation: component.rotation, name: component.name };
    const next = change(previous);
    entry.pose = next;
    const values: Partial<ComponentPose> = {};
    if (next.x !== previous.x) values.x = next.x;
    if (next.y !== previous.y) values.y = next.y;
    if (next.rotation !== previous.rotation) values.rotation = next.rotation;
    if (next.name !== previous.name) values.name = next.name;
    // Selection/mouseup without a move must not create a revision or empty conflict.
    if (Object.keys(values).length === 0) return Promise.resolve(undefined);
    return this.run(component, isCurrent, async revision => ({ ...next, ...await write(next, revision) }),
      schemeId === undefined ? undefined : { schemeId, intent: { kind: 'pose', values } });
  }

  /** Explicit reviewed resolution shares the FIFO with writes and calculation barriers.
   * Without apply, accept the compared server fields; with apply, submit one atomic PATCH.
   */
  recover(draft: ComponentDraft, server: SchemeComponent, selected: ReadonlySet<string>, isCurrent: () => boolean,
    apply?: (patch: ComponentPatch, revision: string) => Promise<ComponentWriteResult>): Promise<SchemeComponent | undefined> {
    const fields = new Set(selected);
    const compared = { ...server, params: { ...server.params } };
    const entry = this.entry(compared);
    const result = entry.tail.then(async () => {
      if (!isCurrent()) return undefined;
      if (!this.drafts.isCurrentReview(draft)) throw new Error('Правки изменились. Повторно откройте сравнение.');
      const prepared = prepareRecoveryPatch(draft, compared, fields);
      const confirmed: SchemeComponent = { ...compared, params: { ...compared.params } };
      if (apply && prepared.patch) {
        const acknowledgement = await apply(prepared.patch, prepared.revision);
        confirmed.revision = parseComponentRevision(acknowledgement.revision);
        Object.assign(confirmed, prepared.patch.pose);
        confirmed.params = { ...confirmed.params, ...prepared.patch.params };
      }
      this.drafts.resolveReviewed(draft, fields, confirmed);
      entry.revision = confirmed.revision;
      entry.pose = { x: confirmed.x, y: confirmed.y, rotation: confirmed.rotation, name: confirmed.name };
      entry.failed = this.drafts.hasFailed(draft.schemeId, compared.id);
      entry.deleted = false;
      return confirmed;
    });
    entry.tail = result.then(() => {}, () => {});
    return result;
  }

  /** Review a failed deletion separately from field patches. Missing means already absent;
   * keep accepts the compared object; delete requires a new conditional DELETE if present.
   */
  recoverDeletion(draft: ComponentDraft, server: SchemeComponent | undefined, mode: 'keep' | 'delete', isCurrent: () => boolean,
    remove?: (revision: string) => Promise<ComponentWriteResult>): Promise<{ deleted: boolean; component?: SchemeComponent } | undefined> {
    const compared = server ? { ...server, params: { ...server.params } } : undefined;
    const entry = this.entry(compared ?? draft.base);
    const result = entry.tail.then(async () => {
      if (!isCurrent()) return undefined;
      if (!this.drafts.isCurrentReview(draft)) throw new Error('Правки изменились. Повторно откройте сравнение.');
      if (!this.drafts.hasReviewedDeletion(draft)) throw new Error('В журнале нет неподтверждённого удаления');
      if (compared && compared.id !== draft.componentId) throw new Error('Сравнивается другое оборудование');
      if (compared && (compared.type !== draft.base.type || compared.typeId !== draft.base.typeId ||
        (compared.equipmentModelId ?? null) !== (draft.base.equipmentModelId ?? null))) {
        throw new Error('Тип или паспорт изменился. Повторно сравните оборудование.');
      }
      if (mode === 'keep' && !compared) throw new Error('Объект отсутствует. Его восстановление требует отдельного решения.');
      if (mode === 'delete' && compared) {
        const revision = parseComponentRevision(compared.revision);
        if (!remove) throw new Error('Не задан обработчик удаления');
        const acknowledgement = await remove(revision);
        if (parseComponentRevision(acknowledgement.revision) !== revision) throw new Error('Версия подтверждения удаления не совпадает с рассмотренной');
      }
      const retained = mode === 'keep' ? compared : undefined;
      this.drafts.resolveDeletion(draft, retained);
      entry.deleted = !retained;
      entry.failed = this.drafts.hasFailed(draft.schemeId, draft.componentId);
      if (retained) {
        entry.revision = retained.revision;
        entry.pose = { x: retained.x, y: retained.y, rotation: retained.rotation, name: retained.name };
      } else entry.pose = undefined;
      return { deleted: !retained, component: retained };
    });
    entry.tail = result.then(() => {}, () => {});
    return result;
  }

  /** Before reload, let dispatched writes settle; stale queued intents are skipped. */
  async settle() {
    for (;;) {
      const tails = new Map([...this.entries].map(([id, entry]) => [id, entry.tail]));
      await Promise.all(tails.values());
      if (tails.size === this.entries.size && [...this.entries].every(([id, entry]) => tails.get(id) === entry.tail)) return;
    }
  }

  reset() { this.entries.clear(); this.drafts.resetBaseline(); }

  assertConfirmed(schemeId?: number) {
    if ([...this.entries.values()].some(entry => entry.failed) || (schemeId !== undefined && this.drafts.hasFailed(schemeId))) {
      throw new Error('Сохранение оборудования не подтверждено. Повторно загрузите схему и разрешите конфликт перед расчётом.');
    }
  }
}
