export type GraphIntent =
  | { kind: 'create-component'; typeId: number; name: string; x: number; y: number; equipmentModelId: number | null }
  | { kind: 'create-connection'; from: number; to: number; fromPort: string; toPort: string }
  | { kind: 'delete-connection'; id: number };

/** Dispatched graph mutations. A lost acknowledgement survives view reloads. */
export class GraphWrites {
  private pending = new Map<number, Set<Promise<void>>>();
  private errors = new Map<number, { intent: GraphIntent; reason: string }[]>();
  private generation = 0;
  get version() { return this.generation; }

  run<T>(schemeId: number, intent: GraphIntent, action: () => Promise<T>): Promise<T> {
    this.generation++;
    const captured = { ...intent };
    const pending = this.pending.get(schemeId) ?? new Set<Promise<void>>();
    this.pending.set(schemeId, pending);
    const result = Promise.resolve().then(action);
    const settled = result.then(() => {}, error => {
      const failures = this.errors.get(schemeId) ?? [];
      failures.push({ intent: captured, reason: error instanceof Error ? error.message : 'Подтверждение записи отсутствует' });
      this.errors.set(schemeId, failures);
    }).then(() => { pending.delete(settled); if (pending.size === 0) this.pending.delete(schemeId); });
    pending.add(settled);
    return result;
  }

  async settle(schemeId: number) {
    for (;;) {
      const pending = this.pending.get(schemeId);
      if (!pending?.size) return;
      await Promise.all([...pending]);
    }
  }

  failed(schemeId: number) { return (this.errors.get(schemeId) ?? []).map(failure => ({ ...failure, intent: { ...failure.intent } })); }

  assertConfirmed(schemeId: number) {
    if (this.errors.get(schemeId)?.length) {
      throw new Error('Изменение состава схемы или соединений не подтверждено. Расчёт заблокирован; требуется сверка сохранённой топологии.');
    }
  }
}
