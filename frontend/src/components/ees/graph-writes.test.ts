import { expect, test } from 'vitest';
import { GraphWrites } from './graph-writes';
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
