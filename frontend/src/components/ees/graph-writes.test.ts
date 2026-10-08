import { expect, test, vi } from 'vitest';
import { GraphWrites, type GraphSnapshot } from './graph-writes';
import { ComponentWrites } from './component-writes';

const intent = { kind: 'delete-connection' as const, id: 1 };
test('uncertain graph changes retain a copied intent and block only their scheme', async () => {
  const writes = new GraphWrites();
  await expect(writes.run(1, intent, async () => { throw new Error('lost acknowledgement'); })).rejects.toThrow();
  await writes.settle(1);
  expect(() => writes.assertConfirmed(1)).toThrow('топологии');
  expect(() => writes.assertConfirmed(2)).not.toThrow();
  const failures = writes.failed(1); failures[0].intent.kind = 'delete-connection';
  (failures[0].intent as typeof intent).id = 99;
  expect(writes.failed(1)[0].intent).toEqual(intent);
});

test('calculation barrier includes graph operations registered while another save is pending', async () => {
  const writes = new ComponentWrites();
  let first!: () => void, second!: () => void;
  const a = writes.graph.run(1, intent, () => new Promise<void>(resolve => { first = resolve; }));
  let finished = false;
  const barrier = writes.settleForCalculation(1).then(() => { finished = true; });
  await Promise.resolve();
  const b = writes.graph.run(1, { ...intent, id: 2 }, () => new Promise<void>(resolve => { second = resolve; }));
  await Promise.resolve(); first(); await a;
  expect(finished).toBe(false);
  second(); await b; await barrier;
  expect(finished).toBe(true);
});

test('view reload does not erase a lost graph acknowledgement', async () => {
  const writes = new ComponentWrites();
  await writes.graph.run(1, intent, async () => { throw new Error('network'); }).catch(() => {});
  await writes.settleForCalculation(1); writes.reset();
  expect(() => writes.assertConfirmed(1)).toThrow('топологии');
  expect(() => writes.assertConfirmed(2)).not.toThrow();
});

const snapshot = (id = 1): GraphSnapshot => ({ id, components: [], connections: [
  { id: 9, from: 2, to: 3, fromPort: 'a', toPort: 'b', validationErrors: ['example'] },
] });
async function fail(writes: GraphWrites, id = 1, schemeId = 1) {
  await writes.run(schemeId, { ...intent, id }, async () => { throw new Error('lost'); }).catch(() => {});
}

test('explicit server acceptance resolves only selected reviewed intentions without writes', async () => {
  const writes = new GraphWrites();
  await fail(writes); await fail(writes, 2);
  const server = snapshot();
  const review = await writes.review(1, async () => server);
  const selected = review.failures[0].id;
  // Neither a caller's DTO nor the visible review can replace the read state.
  server.connections[0].id = 100;
  review.server.connections[0].validationErrors?.push('tampered');
  review.server.connections[0].id = 200;
  review.failures[0].id = 999;
  const accepted = writes.acceptServer(review, 1, new Set([selected]));
  expect(accepted.connections[0].id).toBe(9);
  expect(accepted.connections[0].validationErrors).toEqual(['example']);
  expect(writes.failed(1)).toHaveLength(1);
  expect(() => writes.assertConfirmed(1)).toThrow();
  expect(() => writes.acceptServer(review, 1, new Set([selected]))).toThrow('устарело');
  const remaining = await writes.review(1, async () => snapshot());
  writes.acceptServer(remaining, 1, new Set(remaining.failures.map(failure => failure.id)));
  expect(() => writes.assertConfirmed(1)).not.toThrow();
});

test('forged, cross-scheme and unselected comparisons cannot discard failures', async () => {
  const writes = new GraphWrites(); await fail(writes);
  const review = await writes.review(1, async () => snapshot());
  const ids = new Set(review.failures.map(failure => failure.id));
  expect(() => writes.acceptServer({ ...review }, 1, ids)).toThrow('устарело');
  expect(() => writes.acceptServer(review, 2, ids)).toThrow('устарело');
  expect(() => writes.acceptServer(review, 1, new Set())).toThrow('Выберите');
  expect(() => writes.acceptServer(review, 1, new Set([999]))).toThrow('Выберите');
  expect(writes.failed(1)).toHaveLength(1);
});

test('a mutation during server reading invalidates the comparison and preserves all failures', async () => {
  const writes = new GraphWrites(); await fail(writes);
  let release!: (server: GraphSnapshot) => void;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const review = writes.review(1, () => { started(); return new Promise(resolve => { release = resolve; }); });
  await reading;
  await fail(writes, 2);
  release(snapshot());
  await expect(review).rejects.toThrow('Повторно');
  expect(writes.failed(1)).toHaveLength(2);
});

test('writes after comparison invalidate acceptance even when successfully acknowledged', async () => {
  const writes = new GraphWrites(); await fail(writes);
  const review = await writes.review(1, async () => snapshot());
  await writes.run(1, intent, async () => {}); await writes.settle(1);
  expect(() => writes.acceptServer(review, 1, new Set(review.failures.map(f => f.id)))).toThrow('устарело');
  expect(writes.failed(1)).toHaveLength(1);
});

test('an unrelated scheme does not invalidate a reviewed server snapshot', async () => {
  const writes = new GraphWrites(); await fail(writes);
  const review = await writes.review(1, async () => snapshot());
  await fail(writes, 2, 2);
  writes.acceptServer(review, 1, new Set(review.failures.map(f => f.id)));
  expect(() => writes.assertConfirmed(1)).not.toThrow();
  expect(() => writes.assertConfirmed(2)).toThrow();
});

test('incomplete or different server topology cannot become a review', async () => {
  const writes = new GraphWrites(); await fail(writes);
  await expect(writes.review(1, async () => snapshot(2))).rejects.toThrow('полный состав');
  await expect(writes.review(1, async () => ({ id: 1 } as GraphSnapshot))).rejects.toThrow('полный состав');
  expect(writes.failed(1)).toHaveLength(1);
});

test('comparison reads only after the dispatched write settles', async () => {
  const writes = new GraphWrites(); await fail(writes);
  let release!: () => void;
  const pending = writes.run(1, intent, () => new Promise<void>(resolve => { release = resolve; }));
  const read = vi.fn(async () => snapshot());
  const review = writes.review(1, read);
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  release(); await pending;
  await review;
  expect(read).toHaveBeenCalledOnce();
});

const creation = { kind: 'create-connection' as const, commandId: '11111111-1111-4111-8111-111111111111', from: 2, to: 3, fromPort: 'right', toPort: 'left' };
async function failedCreation(writes: GraphWrites) {
  await writes.run(1, creation, async () => { throw new Error('lost creation'); }).catch(() => {});
  return writes.review(1, async () => snapshot());
}
test('reviewed retry uses the captured key and payload and clears only its confirmed intention', async () => {
  const writes = new GraphWrites(); await fail(writes);
  const review = await failedCreation(writes);
  const failureId = review.failures.find(f => f.intent.kind === 'create-connection')!.id;
  (review.failures.find(f => f.id === failureId)!.intent as typeof creation).commandId = 'tampered';
  const action = vi.fn(async () => ({ id: 9, success: true, commandId: creation.commandId }));
  await writes.retryConnection(review, 1, failureId, () => true, action);
  await writes.settle(1);
  expect(action).toHaveBeenCalledWith(creation);
  expect(writes.failed(1)).toHaveLength(1);
  expect(writes.failed(1)[0].intent.kind).toBe('delete-connection');
});
test('failed retry keeps the same failure and command identity without duplicate journal entries', async () => {
  const writes = new GraphWrites(); const review = await failedCreation(writes);
  const failureId = review.failures[0].id;
  await expect(writes.retryConnection(review, 1, failureId, () => true, async () => { throw new Error('still unavailable'); })).rejects.toThrow();
  await writes.settle(1);
  expect(writes.failed(1)).toEqual([{ id: failureId, intent: creation, reason: 'still unavailable' }]);
  expect(() => writes.assertConfirmed(1)).toThrow();
});
test('retry is included in the barrier and a wrong command acknowledgement retains the failure', async () => {
  const writes = new GraphWrites(); const review = await failedCreation(writes);
  let release!: (ack: { id: number; success: boolean; commandId: string }) => void;
  const retry = writes.retryConnection(review, 1, review.failures[0].id, () => true, () => new Promise(resolve => { release = resolve; }));
  const rejected = expect(retry).rejects.toThrow('Идентичность');
  let settled = false; const barrier = writes.settle(1).then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  release({ id: 9, success: true, commandId: 'wrong' }); await rejected; await barrier;
  expect(writes.failed(1)).toHaveLength(1);
});
test('forged or stale reviews and unsupported intentions never dispatch a retry', async () => {
  const writes = new GraphWrites(); const review = await failedCreation(writes);
  const action = vi.fn(async () => ({ id: 9, success: true, commandId: creation.commandId }));
  expect(() => writes.retryConnection({ ...review }, 1, review.failures[0].id, () => true, action)).toThrow('устарело');
  expect(() => writes.retryConnection(review, 2, review.failures[0].id, () => true, action)).toThrow('устарело');
  expect(() => writes.retryConnection(review, 1, review.failures[0].id, () => false, action)).toThrow('устарело');
  await fail(writes, 2);
  expect(() => writes.retryConnection(review, 1, review.failures[0].id, () => true, action)).toThrow('устарело');
  const fresh = await writes.review(1, async () => snapshot());
  expect(() => writes.retryConnection(fresh, 1, fresh.failures.find(f => f.intent.kind === 'delete-connection')!.id, () => true, action)).toThrow('только');
  expect(action).not.toHaveBeenCalled();
});
