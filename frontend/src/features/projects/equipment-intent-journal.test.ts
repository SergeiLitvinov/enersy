// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ComponentWrites } from '../../components/ees/component-writes';
import { createProjectEditorTransport } from './project-editor-transport';
import { restoreProjectEditorJournal } from './editor-journal';
import { createEquipmentIntentJournal, forgetOtherEquipmentSessions } from './equipment-intent-journal';

const scope = { accountId: '9007199254740993', sessionId: '2', projectId: '8', schemeId: '7' };
const intent = { kind: 'create-component' as const, commandId: '11111111-1111-4111-8111-111111111111', expectedTopologyRevision: '9007199254740993',
  typeId: '1', name: 'Шина', x: 0, y: 0, rotation: 0, equipmentModelId: null, params: { voltage_nom: '110.00' } };
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

test('write-ahead intent survives a new journal instance with exact scope and input', () => {
  const journal = createEquipmentIntentJournal(scope);
  journal.prepare(intent);
  expect(createEquipmentIntentJournal(scope).read()).toEqual([intent]);
  const copy = journal.read(); copy[0].params.voltage_nom = 'changed';
  expect(journal.read()[0].params.voltage_nom).toBe('110.00');
  journal.prepare(intent);
  expect(journal.read()).toHaveLength(1);
  expect(() => journal.prepare({ ...intent, name: 'Other' })).toThrow('другими данными');
  for (const changed of [{ accountId: '3' }, { sessionId: '4' }, { projectId: '9' }, { schemeId: '6' }]) {
    expect(createEquipmentIntentJournal({ ...scope, ...changed }).read()).toEqual([]);
  }
  journal.resolve(intent.commandId);
  expect(journal.read()).toEqual([]);
});

test('storage failure, corrupted context and partial commands fail closed', () => {
  const journal = createEquipmentIntentJournal(scope);
  expect(() => journal.prepare({ ...intent, expectedTopologyRevision: undefined })).toThrow();
  const inaccessible = createEquipmentIntentJournal(scope, () => { throw new Error('storage unavailable'); });
  expect(() => inaccessible.prepare(intent)).toThrow('storage unavailable');
  journal.prepare(intent);
  const key = sessionStorage.key(0)!;
  const body = JSON.parse(sessionStorage.getItem(key)!);
  body.scope.projectId = '9';
  sessionStorage.setItem(key, JSON.stringify(body));
  expect(() => journal.read()).toThrow('повреждён');
});

test('identity switch and logout remove only equipment intentions from other sessions', () => {
  createEquipmentIntentJournal(scope).prepare(intent);
  createEquipmentIntentJournal({ ...scope, sessionId: '3' }).prepare(intent);
  sessionStorage.setItem('unrelated', 'keep');
  forgetOtherEquipmentSessions(scope);
  expect(createEquipmentIntentJournal(scope).read()).toHaveLength(1);
  expect(createEquipmentIntentJournal({ ...scope, sessionId: '3' }).read()).toEqual([]);
  forgetOtherEquipmentSessions(null);
  expect(createEquipmentIntentJournal(scope).read()).toEqual([]);
  expect(sessionStorage.getItem('unrelated')).toBe('keep');
});

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { ETag: '"1"' } });
const graph = (revision: string, present: boolean) => ({ id: '7', projectId: '8', name: 'Graph', description: '', topologyRevision: revision,
  components: present ? [{ id: '10', typeId: '1', type: 'busbar', name: 'Шина', x: 0, y: 0, rotation: 0, revision: '1', equipmentModelId: null, params: { voltage_nom: '110.00' } }] : [], connections: [] });

test.each([false, true])('lost creation survives reopening and replays exact identity before fresh graph (deleted=%s)', async deleted => {
  const journal = createEquipmentIntentJournal(scope);
  const options = { identity: { accountId: scope.accountId, sessionId: scope.sessionId }, projectId: '8', schemeId: '7', name: 'Graph', writable: true, signal: new AbortController().signal,
    onPreparedEquipment: journal.prepare, onResolvedEquipment: journal.resolve };
  const fetcher = vi.fn().mockResolvedValueOnce(response(graph('0', false))).mockImplementationOnce(async () => {
    expect(journal.read()).toHaveLength(1); // Durable before the first POST.
    throw new TypeError('lost acknowledgement');
  });
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options), writes = new ComponentWrites();
  await transport.getScheme(7);
  await expect(writes.graph.run(7, { ...intent, typeId: 1, commandId: undefined, expectedTopologyRevision: undefined },
    capture => transport.addComponent(7, 1, 0, 0, 0, 'Шина', null, { voltage_nom: '110.00' }, capture))).rejects.toThrow('lost acknowledgement');
  const stored = journal.read()[0];
  expect(stored.expectedTopologyRevision).toBe('0');
  expect(fetcher.mock.calls[1][1].headers).toMatchObject({ 'Idempotency-Key': stored.commandId, 'If-Match': '"0"', 'X-Enersy-Account-Id': scope.accountId, 'X-Enersy-Session-Id': scope.sessionId });
  const { queue, transport: reopened } = restoreProjectEditorJournal(options, { formatVersion: 1, components: [], graph: [{ intent: stored, reason: 'lost' }] });
  expect(() => queue.graph.assertConfirmed(7)).toThrow('подтверждено');
  const revision = deleted ? '2' : '1';
  fetcher.mockResolvedValueOnce(response(graph(revision, !deleted)))
    .mockResolvedValueOnce(response({ success: true, id: '10', revision: '1', params: { voltage_nom: '110.00' }, equipmentModelId: null,
      commandId: stored.commandId, topologyRevision: revision, deleted }))
    .mockResolvedValueOnce(response(graph(revision, !deleted)));
  const review = await queue.graph.review(7, async () => {
    const value = await reopened.getScheme(7);
    return { id: 7, components: value.components!, connections: value.connections! };
  });
  await queue.graph.retryCreation(review, 7, review.failures[0].id, () => true, async candidate => {
    expect(candidate.commandId).toBe(stored.commandId);
    return reopened.retryComponentCreation!(stored);
  }, async () => {
    const value = await reopened.getScheme(7);
    expect(value.components).toHaveLength(deleted ? 0 : 1);
    reopened.completeComponentReplay!(stored.commandId!);
  });
  expect(fetcher.mock.calls[3][1].headers).toEqual(fetcher.mock.calls[1][1].headers);
  expect(fetcher.mock.calls[3][1].body).toBe(fetcher.mock.calls[1][1].body);
  expect(journal.read()).toEqual([]);
  expect(() => queue.graph.assertConfirmed(7)).not.toThrow();
});

test('failed write-ahead storage prevents the network creation request', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(graph('0', false)));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport({ projectId: '8', schemeId: '7', name: 'Graph', writable: true, signal: new AbortController().signal,
    onPreparedEquipment: () => { throw new Error('storage full'); } });
  await transport.getScheme(7);
  await expect(transport.addComponent(7, 1, 0, 0, 0, 'Шина')).rejects.toThrow('storage full');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
