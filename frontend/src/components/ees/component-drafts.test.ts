import { expect, test, vi } from 'vitest';
import type { SchemeComponent } from '../../api/ees-api';
import { ComponentWrites } from './component-writes';
import { ComponentDrafts } from './component-drafts';

const component: SchemeComponent = { id: 101, revision: '1', type: 'busbar', typeId: 1, name: 'Bus', x: 0, y: 0, rotation: 0, params: { voltage: '110' } };

test('selection or unchanged mouseup creates neither a pose write nor an empty failed intent', async () => {
  const queue = new ComponentWrites();
  queue.seed(1, component);
  const write = vi.fn().mockRejectedValue(new Error('stale revision'));
  expect(await queue.pose(component, pose => ({ ...pose }), () => true, write, 1)).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
  expect(queue.drafts.failed(1)).toEqual([]);
  expect(() => queue.assertConfirmed(1)).not.toThrow();
});

test('reload preserves failed intents and their original baseline independently per scheme', () => {
  const drafts = new ComponentDrafts();
  drafts.seed(1, component);
  const ticket = drafts.record(1, { ...component, x: 20 }, { kind: 'pose', values: { x: 20 } });
  drafts.fail(ticket, 'conflict');
  drafts.resetBaseline();
  drafts.seed(1, { ...component, revision: '8', x: 100 });
  expect(drafts.failed(1)[0]).toMatchObject({ base: { revision: '1', x: 0 }, intents: [{ kind: 'pose', values: { x: 20 } }] });
  expect(drafts.failed(2)).toEqual([]);
  const other = drafts.record(2, { ...component, name: 'Other' }, { kind: 'delete' });
  drafts.fail(other, 'network');
  drafts.discard(1, 101);
  expect(drafts.failed(1)).toEqual([]);
  expect(drafts.failed(2)[0].base.name).toBe('Other');
});

test('acknowledged edits become the baseline for remaining pending intents', () => {
  const drafts = new ComponentDrafts();
  drafts.seed(1, component);
  const move = drafts.record(1, component, { kind: 'pose', values: { x: 20 } });
  const param = drafts.record(1, component, { kind: 'parameter', key: 'voltage', value: '220' });
  drafts.acknowledge(move, '2');
  drafts.fail(param, 'conflict');
  expect(drafts.failed(1)[0]).toMatchObject({ base: { revision: '2', x: 20, params: { voltage: '110' } }, intents: [{ kind: 'parameter', key: 'voltage', value: '220' }] });
  const snapshot = drafts.failed(1)[0];
  snapshot.base.params.voltage = 'changed outside';
  snapshot.intents.length = 0;
  expect(drafts.failed(1)[0].base.params.voltage).toBe('110');
  expect(drafts.failed(1)[0].intents).toHaveLength(1);
  drafts.acknowledge(param, '3');
  expect(drafts.failed(1)).toEqual([]);
});

test('failed FIFO writes keep all pending field edits, parameters and deletion across reset', async () => {
  const queue = new ComponentWrites();
  queue.seed(1, component);
  const write = vi.fn().mockRejectedValue(new Error('conflict'));
  const parameter = vi.fn();
  const deletion = vi.fn();
  // The React graph already moved optimistically. Recovery still uses server baseline.
  const move = queue.pose({ ...component, x: 20 }, pose => ({ ...pose, x: 20 }), () => true, write, 1);
  const rotate = queue.pose({ ...component, x: 20 }, pose => ({ ...pose, rotation: 90 }), () => true, write, 1);
  const param = queue.run(component, () => true, parameter, { schemeId: 1, intent: { kind: 'parameter', key: 'voltage', value: '220' } });
  const remove = queue.run(component, () => true, deletion, { schemeId: 1, intent: { kind: 'delete' } });
  await Promise.allSettled([move, rotate, param, remove]);
  expect(write).toHaveBeenCalledTimes(1);
  expect(parameter).not.toHaveBeenCalled();
  expect(deletion).not.toHaveBeenCalled();
  queue.reset();
  queue.seed(1, { ...component, revision: '8', x: 100 });
  expect(queue.drafts.failed(1)[0]).toMatchObject({ base: { revision: '1', x: 0 }, intents: [
    { kind: 'pose', values: { x: 20 } }, { kind: 'pose', values: { rotation: 90 } },
    { kind: 'parameter', key: 'voltage', value: '220' }, { kind: 'delete' },
  ] });
  expect(() => queue.assertConfirmed(1)).toThrow();
});

test('stale queued intent is removed while dispatched lost acknowledgement is retained', async () => {
  const queue = new ComponentWrites();
  queue.seed(1, component);
  let reject!: (error: Error) => void;
  let current = true;
  const dispatched = queue.run(component, () => current, () => new Promise<{success: true; revision: string}>((_, no) => { reject = no; }),
    { schemeId: 1, intent: { kind: 'parameter', key: 'voltage', value: '220' } });
  const queued = queue.run(component, () => current, vi.fn(), { schemeId: 1, intent: { kind: 'delete' } });
  await Promise.resolve();
  current = false;
  reject(new Error('lost acknowledgement'));
  await Promise.allSettled([dispatched, queued]);
  expect(queue.drafts.failed(1)[0].intents).toEqual([{ kind: 'parameter', key: 'voltage', value: '220' }]);
});

test('another scheme can run while failed draft requires explicit discard and fresh baseline', async () => {
  const queue = new ComponentWrites();
  queue.seed(1, component);
  await expect(queue.run(component, () => true, async () => { throw new Error('conflict'); },
    { schemeId: 1, intent: { kind: 'parameter', key: 'voltage', value: '220' } })).rejects.toThrow('conflict');
  queue.reset();
  queue.seed(2, { ...component, id: 102 });
  expect(() => queue.assertConfirmed(2)).not.toThrow();
  queue.reset();
  queue.seed(1, { ...component, revision: '8' });
  const write = vi.fn().mockResolvedValue({ success: true, revision: '9' });
  await expect(queue.run(component, () => true, write, { schemeId: 1, intent: { kind: 'delete' } })).rejects.toThrow('разрешите конфликт');
  expect(write).not.toHaveBeenCalled();
  queue.drafts.discard(1, 101);
  queue.reset();
  queue.seed(1, { ...component, revision: '8' });
  await queue.run(component, () => true, write, { schemeId: 1, intent: { kind: 'parameter', key: 'voltage', value: '110' } });
  expect(write).toHaveBeenCalledWith('8');
  expect(() => queue.assertConfirmed(1)).not.toThrow();
});

test('review resolves selected fields across repeated intents and keeps unreviewed conflicts', () => {
  const drafts = new ComponentDrafts();
  const first = drafts.record(1, component, { kind: 'pose', values: { x: 10, y: 20 } });
  drafts.record(1, component, { kind: 'pose', values: { x: 30, rotation: 90 } });
  drafts.record(1, component, { kind: 'parameter', key: 'voltage', value: '220' });
  drafts.record(1, component, { kind: 'delete' });
  drafts.fail(first, 'conflict');
  const review = drafts.failed(1)[0];
  expect(drafts.isCurrentReview(review)).toBe(true);
  const server = { ...component, revision: '8', x: 30, y: 200, params: { voltage: '330' } };
  expect(drafts.resolveReviewed(review, new Set(['pose:x']), server)).toBe(true);
  expect(drafts.isCurrentReview(review)).toBe(false);
  expect(drafts.failed(1)[0]).toMatchObject({ reason: 'conflict', base: { x: 30, y: 0, params: { voltage: '110' } }, intents: [
    { kind: 'pose', values: { y: 20 } }, { kind: 'pose', values: { rotation: 90 } },
    { kind: 'parameter', key: 'voltage', value: '220' }, { kind: 'delete' },
  ] });
  expect(drafts.resolveReviewed(review, new Set(['pose:x']), server)).toBe(false);
});

test('a new edit to the same field during recovery survives the reviewed acknowledgement', () => {
  const drafts = new ComponentDrafts();
  const ticket = drafts.record(1, component, { kind: 'parameter', key: 'voltage', value: '220' });
  drafts.fail(ticket, 'lost acknowledgement');
  const review = drafts.failed(1)[0];
  drafts.record(1, component, { kind: 'parameter', key: 'voltage', value: '500' });
  expect(drafts.isCurrentReview(review)).toBe(false);
  expect(drafts.resolveReviewed(review, new Set(['parameter:voltage']), { ...component, revision: '8', params: { voltage: '220' } })).toBe(true);
  expect(drafts.failed(1)[0]).toMatchObject({ base: { params: { voltage: '220' } }, intents: [
    { kind: 'parameter', key: 'voltage', value: '500' },
  ] });
  expect(drafts.hasFailed(1, 101)).toBe(true);
});

test('review identity cannot be forged or retargeted by mutating the public snapshot', () => {
  const drafts = new ComponentDrafts();
  const ticket = drafts.record(1, component, { kind: 'pose', values: { x: 10 } });
  drafts.fail(ticket, 'conflict');
  const other = drafts.record(2, component, { kind: 'pose', values: { x: 40 } });
  drafts.fail(other, 'other conflict');
  const review = drafts.failed(1)[0];
  expect(() => drafts.resolveReviewed({ ...review }, new Set(['pose:x']), component)).toThrow('Повторно');
  review.schemeId = 2;
  review.componentId = 999;
  review.intents.push({ kind: 'parameter', key: 'forged', value: 'value' });
  expect(() => drafts.resolveReviewed(review, new Set(['parameter:forged']), component)).toThrow('рассмотренные');
  expect(drafts.resolveReviewed(review, new Set(['pose:x']), { ...component, revision: '2', x: 10 })).toBe(true);
  expect(drafts.failed(1)).toEqual([]);
  expect(drafts.failed(2)[0].intents).toEqual([{ kind: 'pose', values: { x: 40 } }]);
});

test('invalid resolution leaves the entire journal intact and cannot combine deletion with a patch', () => {
  const drafts = new ComponentDrafts();
  const ticket = drafts.record(1, component, { kind: 'pose', values: { x: 10 } });
  drafts.record(1, component, { kind: 'delete' });
  drafts.fail(ticket, 'conflict');
  const review = drafts.failed(1)[0];
  for (const selected of [new Set<string>(), new Set(['delete']), new Set(['pose:x', 'delete'])]) {
    expect(() => drafts.resolveReviewed(review, selected, component)).toThrow();
  }
  expect(() => drafts.resolveReviewed(review, new Set(['pose:x']), { ...component, typeId: 2 })).toThrow('паспорт');
  expect(() => drafts.resolveReviewed(review, new Set(['pose:x']), { ...component, revision: '01' })).toThrow();
  expect(drafts.isCurrentReview(review)).toBe(true);
  expect(drafts.failed(1)[0].intents).toEqual(review.intents);
});

test('accepting an absent server parameter preserves absence and seeds future confirmed writes', () => {
  const drafts = new ComponentDrafts();
  const ticket = drafts.record(1, component, { kind: 'parameter', key: 'voltage', value: '' });
  drafts.fail(ticket, 'conflict');
  const review = drafts.failed(1)[0];
  expect(drafts.resolveReviewed(review, new Set(['parameter:voltage']), { ...component, revision: '9', params: {} })).toBe(true);
  expect(drafts.hasFailed(1)).toBe(false);
  const next = drafts.record(1, component, { kind: 'pose', values: { y: 20 } });
  drafts.fail(next, 'next conflict');
  expect(drafts.failed(1)[0].base).toMatchObject({ revision: '9', params: {} });
  expect(Object.prototype.hasOwnProperty.call(drafts.failed(1)[0].base.params, 'voltage')).toBe(false);
});

test('atomic recovery uses the compared revision and releases subsequent writes only after acknowledgement', async () => {
  const queue = new ComponentWrites();
  queue.seed(1, component);
  const ticket = queue.drafts.record(1, component, { kind: 'pose', values: { x: 20 } });
  queue.drafts.fail(ticket, 'conflict');
  const review = queue.drafts.failed(1)[0];
  const apply = vi.fn().mockResolvedValue({ success: true, revision: '9' });
  const server = { ...component, revision: '8', y: 200 };
  expect(await queue.recover(review, server, new Set(['pose:x']), () => true, apply)).toMatchObject({ revision: '9', x: 20, y: 200 });
  expect(apply).toHaveBeenCalledWith({ pose: { x: 20 } }, '8');
  expect(() => queue.assertConfirmed(1)).not.toThrow();
  const write = vi.fn().mockResolvedValue({ success: true, revision: '10' });
  await queue.pose(component, p => ({ ...p, rotation: 90 }), () => true, write, 1);
  expect(write).toHaveBeenCalledWith({ x: 20, y: 200, rotation: 90, name: 'Bus' }, '9');
});

test('recovery holds the settle barrier and preserves a new intent submitted during the request', async () => {
  const queue = new ComponentWrites();
  const ticket = queue.drafts.record(1, component, { kind: 'pose', values: { x: 20 } });
  queue.drafts.fail(ticket, 'conflict');
  let acknowledge!: (result: { success: true; revision: string }) => void;
  const recovering = queue.recover(queue.drafts.failed(1)[0], { ...component, revision: '8' }, new Set(['pose:x']), () => true,
    () => new Promise(resolve => { acknowledge = resolve; }));
  await Promise.resolve();
  let settled = false;
  const settling = queue.settle().then(() => { settled = true; });
  const write = vi.fn();
  const later = queue.run(component, () => true, write, { schemeId: 1, intent: { kind: 'pose', values: { x: 50 } } });
  await Promise.resolve();
  expect(settled).toBe(false);
  acknowledge({ success: true, revision: '9' });
  await recovering;
  await expect(later).rejects.toThrow('разрешите конфликт');
  await settling;
  expect(write).not.toHaveBeenCalled();
  expect(queue.drafts.failed(1)[0].intents).toEqual([{ kind: 'pose', values: { x: 50 } }]);
  expect(() => queue.assertConfirmed(1)).toThrow();
});

test('recovery rejection and stale review never clear failed local intentions', async () => {
  const queue = new ComponentWrites();
  const ticket = queue.drafts.record(1, component, { kind: 'pose', values: { x: 20 } });
  queue.drafts.fail(ticket, 'conflict');
  const review = queue.drafts.failed(1)[0];
  const apply = vi.fn().mockRejectedValue(new Error('412 conflict'));
  await expect(queue.recover(review, { ...component, revision: '8' }, new Set(['pose:x']), () => true, apply)).rejects.toThrow('412');
  expect(queue.drafts.isCurrentReview(review)).toBe(true);
  queue.drafts.record(1, component, { kind: 'parameter', key: 'voltage', value: '220' });
  apply.mockClear();
  await expect(queue.recover(review, component, new Set(['pose:x']), () => true, apply)).rejects.toThrow('Правки изменились');
  expect(apply).not.toHaveBeenCalled();
  expect(queue.drafts.failed(1)[0].intents).toHaveLength(2);
});

test('explicit server acceptance and already matching values require no PATCH; a stale view resolves nothing', async () => {
  const queue = new ComponentWrites();
  const ticket = queue.drafts.record(1, component, { kind: 'pose', values: { x: 20 } });
  queue.drafts.fail(ticket, 'conflict');
  const review = queue.drafts.failed(1)[0];
  const apply = vi.fn();
  expect(await queue.recover(review, component, new Set(['pose:x']), () => false, apply)).toBeUndefined();
  expect(queue.drafts.hasFailed(1)).toBe(true);
  await queue.recover(review, { ...component, revision: '8', x: 20 }, new Set(['pose:x']), () => true, apply);
  expect(apply).not.toHaveBeenCalled();
  expect(() => queue.assertConfirmed(1)).not.toThrow();
  const next = queue.drafts.record(1, component, { kind: 'pose', values: { x: 30 } });
  queue.drafts.fail(next, 'next conflict');
  await queue.recover(queue.drafts.failed(1)[0], { ...component, revision: '10', x: 100 }, new Set(['pose:x']), () => true);
  const write = vi.fn().mockResolvedValue({ success: true, revision: '11' });
  await queue.run(component, () => true, write);
  expect(write).toHaveBeenCalledWith('10');
});

function deletionQueue() {
  const queue = new ComponentWrites();
  queue.seed(1, component);
  const ticket = queue.drafts.record(1, component, { kind: 'delete' });
  queue.drafts.fail(ticket, 'lost deletion acknowledgement');
  return queue;
}

test('keeping the server object removes only reviewed deletion and uses its version for later writes', async () => {
  const queue = deletionQueue();
  queue.drafts.record(1, component, { kind: 'parameter', key: 'voltage', value: '220' });
  const server = { ...component, revision: '8', x: 100 };
  const remove = vi.fn();
  const resolved = await queue.recoverDeletion(queue.drafts.failed(1)[0], server, 'keep', () => true, remove);
  expect(resolved).toEqual({ deleted: false, component: server });
  expect(remove).not.toHaveBeenCalled();
  expect(queue.drafts.failed(1)[0].intents).toEqual([{ kind: 'parameter', key: 'voltage', value: '220' }]);
  expect(() => queue.assertConfirmed(1)).toThrow();
  await queue.recover(queue.drafts.failed(1)[0], server, new Set(['parameter:voltage']), () => true);
  const write = vi.fn().mockResolvedValue({ success: true, revision: '9' });
  await queue.pose(component, pose => ({ ...pose, rotation: 90 }), () => true, write, 1);
  expect(write).toHaveBeenCalledWith({ x: 100, y: 0, rotation: 90, name: 'Bus' }, '8');
});

test('retry deletion checks the exact compared revision and blocks future writes to the deleted object', async () => {
  const queue = deletionQueue();
  const remove = vi.fn().mockResolvedValue({ success: true, revision: '8' });
  expect(await queue.recoverDeletion(queue.drafts.failed(1)[0], { ...component, revision: '8' }, 'delete', () => true, remove)).toEqual({ deleted: true });
  expect(remove).toHaveBeenCalledWith('8');
  expect(queue.drafts.failed(1)).toEqual([]);
  expect(() => queue.assertConfirmed(1)).not.toThrow();
  const write = vi.fn();
  await expect(queue.run(component, () => true, write)).rejects.toThrow('не подтверждено');
  expect(write).not.toHaveBeenCalled();
});

test('already missing object confirms only deletion without another request or discarding its field edits', async () => {
  const queue = deletionQueue();
  queue.drafts.record(1, component, { kind: 'pose', values: { x: 20 } });
  const remove = vi.fn();
  expect(await queue.recoverDeletion(queue.drafts.failed(1)[0], undefined, 'delete', () => true, remove)).toEqual({ deleted: true });
  expect(remove).not.toHaveBeenCalled();
  expect(queue.drafts.failed(1)[0].intents).toEqual([{ kind: 'pose', values: { x: 20 } }]);
  expect(() => queue.assertConfirmed(1)).toThrow();
});

test('a new deletion intent during the conditional DELETE survives and settle waits for acknowledgement', async () => {
  const queue = deletionQueue();
  let acknowledge!: (value: { success: true; revision: string }) => void;
  const recovering = queue.recoverDeletion(queue.drafts.failed(1)[0], { ...component, revision: '8' }, 'delete', () => true,
    () => new Promise(resolve => { acknowledge = resolve; }));
  await Promise.resolve();
  let settled = false;
  const barrier = queue.settle().then(() => { settled = true; });
  queue.drafts.record(1, component, { kind: 'delete' });
  await Promise.resolve();
  expect(settled).toBe(false);
  acknowledge({ success: true, revision: '8' });
  await recovering;
  await barrier;
  expect(queue.drafts.failed(1)[0].intents).toEqual([{ kind: 'delete' }]);
});

test('failed, invalid and stale deletion recovery never resolves local intentions', async () => {
  const queue = deletionQueue();
  const review = queue.drafts.failed(1)[0];
  const remove = vi.fn().mockRejectedValue(new Error('412 conflict'));
  await expect(queue.recoverDeletion(review, { ...component, revision: '8' }, 'delete', () => true, remove)).rejects.toThrow('412');
  remove.mockResolvedValue({ success: true, revision: '9' });
  await expect(queue.recoverDeletion(review, { ...component, revision: '8' }, 'delete', () => true, remove)).rejects.toThrow('Версия подтверждения');
  remove.mockClear();
  await expect(queue.recoverDeletion(review, { ...component, typeId: 2 }, 'delete', () => true, remove)).rejects.toThrow('паспорт');
  await expect(queue.recoverDeletion(review, { ...component, typeId: 2 }, 'keep', () => true, remove)).rejects.toThrow('паспорт');
  await expect(queue.recoverDeletion(review, undefined, 'keep', () => true, remove)).rejects.toThrow('отсутствует');
  expect(await queue.recoverDeletion(review, component, 'delete', () => false, remove)).toBeUndefined();
  queue.drafts.record(1, component, { kind: 'pose', values: { x: 20 } });
  await expect(queue.recoverDeletion(review, component, 'delete', () => true, remove)).rejects.toThrow('Правки изменились');
  expect(remove).not.toHaveBeenCalled();
  expect(queue.drafts.failed(1)[0].intents).toHaveLength(2);
});

test('a fabricated public deletion cannot authorize deletion of a journal containing only field edits', async () => {
  const queue = new ComponentWrites();
  const ticket = queue.drafts.record(1, component, { kind: 'pose', values: { x: 20 } });
  queue.drafts.fail(ticket, 'conflict');
  const review = queue.drafts.failed(1)[0];
  review.intents.push({ kind: 'delete' });
  const remove = vi.fn();
  await expect(queue.recoverDeletion(review, component, 'delete', () => true, remove)).rejects.toThrow('нет неподтверждённого');
  expect(remove).not.toHaveBeenCalled();
});
