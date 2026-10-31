import { afterEach, expect, test, vi } from 'vitest';
import fixtureJSON from '../../../../tests/fixtures/editor-draft-v1.json?raw';
import { parseEditorDraftPayload } from '../../api/editor-draft-payload';
import { ComponentWrites } from '../../components/ees/component-writes';
import type { GraphDispatchCapture } from '../../components/ees/scheme-transport';
import { captureEditorJournal, restoreProjectEditorJournal } from './editor-journal';
import { createProjectEditorTransport } from './project-editor-transport';

afterEach(() => vi.unstubAllGlobals());
const fixture = () => parseEditorDraftPayload(JSON.parse(fixtureJSON));
const options = () => ({ projectId: '9007199254740993', schemeId: '7', name: 'Private', writable: true, signal: new AbortController().signal });
const component = () => ({ id: 10, typeId: 1, type: 'busbar', name: 'Шина', x: 0, y: 1, rotation: 0,
  revision: '9007199254740993', equipmentModelId: null, params: { voltage_nom: '110' } });
const link = { id: '20', from: '10', to: '11', fromPort: 'right', toPort: 'left', validationErrors: [] };
const graph = (revision = '0', connected = false) => ({ id: '7', projectId: '9007199254740993', name: 'Private', description: '',
  topologyRevision: revision, components: [component(), { ...component(), id: 11 }].map(item => ({ ...item, id: String(item.id), typeId: String(item.typeId) })),
  connections: connected ? [link] : [] });
const reply = (value: unknown, revision?: string) => new Response(JSON.stringify(value), { headers: revision ? { ETag: `"${revision}"` } : {} });

test('restored unit evidence survives new server seeding, capture and independent workspaces', () => {
  const original = fixture();
  original.components[0].base.declaredParameterUnits = { formatVersion: 1, units: { voltage_nom: 'кВ' } };
  const restored = restoreProjectEditorJournal(options(), original);
  restored.queue.seed(7, { ...component(), revision: '99', declaredParameterUnits: { formatVersion: 1, units: { voltage_nom: 'В' } } });
  const captured = captureEditorJournal(restored.queue, '7');
  expect(captured.components[0].base.declaredParameterUnits?.units.voltage_nom).toBe('кВ');
  captured.components[0].base.declaredParameterUnits!.units.voltage_nom = 'tampered';
  original.components[0].base.declaredParameterUnits.units.voltage_nom = 'outside';
  expect(captureEditorJournal(restored.queue, '7').components[0].base.declaredParameterUnits?.units.voltage_nom).toBe('кВ');
  const old = restoreProjectEditorJournal(options(), fixture());
  old.queue.seed(7, { ...component(), declaredParameterUnits: { formatVersion: 1, units: { voltage_nom: 'В' } } });
  expect(captureEditorJournal(old.queue, '7').components[0].base).not.toHaveProperty('declaredParameterUnits');
});

test('component snapshot includes pending work, makes independent copies and only removes acknowledged intentions', async () => {
  const writes = new ComponentWrites(), original = component();
  writes.seed(7, original);
  let acknowledge!: (value: { success: true; revision: string }) => void;
  const pending = writes.run(original, () => true, () => new Promise<{ success: true; revision: string }>(resolve => { acknowledge = resolve; }),
    { schemeId: 7, intent: { kind: 'parameter', key: 'voltage_nom', value: '115' } });
  const snapshot = captureEditorJournal(writes, '7');
  expect(snapshot.components[0]).toMatchObject({ reason: '', base: { revision: original.revision, params: { voltage_nom: '110' } } });
  snapshot.components[0].base.params.voltage_nom = 'tampered';
  expect(captureEditorJournal(writes, '7').components[0].base.params.voltage_nom).toBe('110');
  expect(captureEditorJournal(writes, '8').components).toEqual([]);
  await Promise.resolve(); acknowledge({ success: true, revision: '9007199254740994' }); await pending;
  expect(captureEditorJournal(writes, '7').components).toEqual([]);
});

test('acknowledged predecessor advances the baseline of the remaining queued intention without losing its original fields', async () => {
  const writes = new ComponentWrites(), original = component(); writes.seed(7, original);
  const first = writes.run(original, () => true, async () => ({ success: true, revision: '9007199254740994' }),
    { schemeId: 7, intent: { kind: 'parameter', key: 'voltage_nom', value: '115' } });
  const second = writes.run(original, () => true, async () => { throw new Error('lost pose'); },
    { schemeId: 7, intent: { kind: 'pose', values: { x: 25 } } });
  const failed = second.catch(() => {}); await first; await failed;
  expect(captureEditorJournal(writes, '7').components[0]).toMatchObject({ base: { revision: '9007199254740994', x: 0, params: { voltage_nom: '115' } },
    intents: [{ kind: 'pose', values: { x: 25 } }], reason: 'lost pose' });
});

test('restore is local, retains historical bases after fresh server seeding and blocks calculation until explicit review', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const original = fixture();
  const restored = restoreProjectEditorJournal(options(), original);
  expect(fetcher).not.toHaveBeenCalled();
  expect(() => restored.queue.assertConfirmed(7)).toThrow();
  restored.queue.seed(7, { ...component(), revision: '99', params: { voltage_nom: '220' } });
  const captured = captureEditorJournal(restored.queue, '7');
  expect(captured.components[0].base).toEqual(original.components[0].base);
  expect(captured.graph.map(item => item.intent)).toEqual(original.graph.map(item => item.intent));
  original.components[0].base.params.voltage_nom = 'changed outside';
  expect(captureEditorJournal(restored.queue, '7').components[0].base.params.voltage_nom).toBe('110');
  await expect(restored.queue.run(component(), () => true, async () => { throw new Error('must never dispatch'); },
    { schemeId: 7, intent: { kind: 'parameter', key: 'voltage_nom', value: '230' } })).rejects.toThrow('не подтверждено');
  expect(fetcher).not.toHaveBeenCalled();
});

test('restored pending intentions acquire a review barrier; malformed or cross-scheme contexts never issue a request', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const value = fixture(); value.components[0].reason = ''; value.graph.forEach(item => { item.reason = ''; });
  const { queue } = restoreProjectEditorJournal(options(), value);
  expect(queue.drafts.failed(7)[0].reason).toContain('сверки');
  expect(queue.graph.failed(7).every(item => item.reason.includes('сверки'))).toBe(true);
  const bad = fixture(); bad.graph.push(bad.graph[1]);
  expect(() => restoreProjectEditorJournal(options(), bad)).toThrow();
  expect(() => restoreProjectEditorJournal({ ...options(), schemeId: '../7' }, value)).toThrow();
  const controller = new AbortController(); controller.abort();
  expect(() => restoreProjectEditorJournal({ ...options(), signal: controller.signal }, value)).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test('reviewed restored connection replays original UUID, payload and CAS after a newer topology read', async () => {
  const wire = fixture().graph[1].intent;
  if (wire.kind !== 'create-connection') throw new Error('Fixture kind');
  const value = { formatVersion: 1, components: [], graph: [{ intent: wire, reason: 'lost response' }] };
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('9007199254740999')))
    .mockResolvedValueOnce(reply({ success: true, id: '20', commandId: wire.commandId, deleted: true, topologyRevision: '9007199254740995' }, '9007199254740995'))
    .mockResolvedValueOnce(reply(graph('9007199254740999')));
  vi.stubGlobal('fetch', fetcher);
  const { queue, transport } = restoreProjectEditorJournal(options(), value);
  const review = await queue.graph.review(7, async () => {
    const loaded = await transport.getScheme(7);
    if (!loaded.components || !loaded.connections) throw new Error('Incomplete graph');
    return { id: loaded.id, components: loaded.components, connections: loaded.connections };
  });
  await queue.graph.retryConnection(review, 7, review.failures[0].id, () => true,
    intent => transport.addConnection(7, intent.from, intent.to, intent.fromPort, intent.toPort, intent.commandId),
    async () => { await transport.getScheme(7); });
  expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'POST', headers: { 'If-Match': '"9007199254740994"', 'Idempotency-Key': wire.commandId },
    body: JSON.stringify({ from: '10', to: '11', fromPort: 'right', toPort: 'left' }) });
  expect(captureEditorJournal(queue, '7').graph).toEqual([]);
  expect(() => queue.assertConfirmed(7)).not.toThrow();
});

test('two deletion failures for the same edge keep separate original topology revisions', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('3', true))).mockRejectedValueOnce(new TypeError('lost first'))
    .mockResolvedValueOnce(reply(graph('5', true))).mockRejectedValueOnce(new TypeError('lost second'));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options()), writes = new ComponentWrites();
  await transport.getScheme(7);
  await writes.graph.run(7, { kind: 'delete-connection', id: 20 }, capture => transport.deleteConnection(20, capture)).catch(() => {});
  await transport.getScheme(7);
  await writes.graph.run(7, { kind: 'delete-connection', id: 20 }, capture => transport.deleteConnection(20, capture)).catch(() => {});
  expect(captureEditorJournal(writes, '7').graph.map(item => item.intent)).toEqual([
    { kind: 'delete-connection', id: '20', expectedTopologyRevision: '3' }, { kind: 'delete-connection', id: '20', expectedTopologyRevision: '5' },
  ]);
});

test('dispatch preparation can wait for persistence, and a different intent cannot replace the original journal command', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('8'))).mockRejectedValueOnce(new TypeError('lost'));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options()), writes = new ComponentWrites(); await transport.getScheme(7);
  let release!: () => void;
  const prepared = new Promise<void>(resolve => { release = resolve; });
  const commandId = '11111111-1111-4111-8111-111111111111';
  const pending = writes.graph.run(7, { kind: 'create-connection', commandId, from: 10, to: 11, fromPort: 'right', toPort: 'left' },
    capture => transport.addConnection(7, 10, 11, 'right', 'left', commandId, async wire => { await capture(wire); await prepared; }));
  await vi.waitFor(() => expect(captureEditorJournal(writes, '7').graph[0].intent).toMatchObject({ expectedTopologyRevision: '8' }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(); await expect(pending).rejects.toThrow('lost');
  expect(captureEditorJournal(writes, '7').graph[0].reason).toBe('lost');
});

test('a queued command is exported explicitly without a fabricated revision', async () => {
  const writes = new ComponentWrites(); let release!: () => void;
  const pending = writes.graph.run(7, { kind: 'delete-connection', id: 20 }, () => new Promise<void>(resolve => { release = resolve; }));
  expect(captureEditorJournal(writes, '7')).toMatchObject({ formatVersion: 2, graph: [{ phase: 'unprepared', intent: { kind: 'delete-connection', id: '20' } }] });
  expect(captureEditorJournal(writes, '7').graph[0].intent).not.toHaveProperty('expectedTopologyRevision');
  await Promise.resolve(); release(); await pending;
  expect(captureEditorJournal(writes, '7').graph).toEqual([]);
});

test('component creation retains complete dispatch parameters while caller and capture copies are mutated', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph())).mockRejectedValueOnce(new TypeError('lost creation'));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options()), writes = new ComponentWrites(); await transport.getScheme(7);
  const params = { voltage_nom: '110' };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = writes.graph.run(7, { kind: 'create-component', typeId: 1, name: 'Шина', x: 3, y: 4, rotation: 90, equipmentModelId: null, params },
    capture => transport.addComponent(7, 1, 3, 4, 90, 'Шина', null, params, async wire => {
      await capture(wire);
      if (wire.kind === 'create-component') wire.params.voltage_nom = 'tampered observer';
      await gate;
    }));
  await vi.waitFor(() => expect(captureEditorJournal(writes, '7').graph[0].phase).toBe('prepared'));
  params.voltage_nom = 'changed caller'; release();
  await expect(pending).rejects.toThrow('lost creation');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ rotation: 90, params: { voltage_nom: '110' } });
  expect(captureEditorJournal(writes, '7').graph[0].intent).toMatchObject({ rotation: 90, params: { voltage_nom: '110' } });
});

test('explicit acceptance removes only selected structural records from the serializable journal', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply(graph())); vi.stubGlobal('fetch', fetcher);
  const { queue, transport } = restoreProjectEditorJournal(options(), fixture());
  const review = await queue.graph.review(7, async () => {
    const loaded = await transport.getScheme(7);
    if (!loaded.components || !loaded.connections) throw new Error('Incomplete graph');
    return { id: loaded.id, components: loaded.components, connections: loaded.connections };
  });
  queue.graph.acceptServer(review, 7, new Set([review.failures[0].id]));
  const snapshot = captureEditorJournal(queue, '7');
  expect(snapshot.graph.map(item => item.intent)).toEqual(fixture().graph.slice(1).map(item => item.intent));
  expect(snapshot.components[0].base).toEqual(fixture().components[0].base);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(() => queue.assertConfirmed(7)).toThrow();
});

test('capture is bound to one active operation; mismatched commands and late mutation are rejected', async () => {
  const writes = new ComponentWrites(); let saved!: GraphDispatchCapture;
  await expect(writes.graph.run(7, { kind: 'delete-connection', id: 20 }, async capture => {
    saved = capture;
    await capture({ kind: 'delete-connection', id: '21', expectedTopologyRevision: '0' });
  })).rejects.toThrow('не совпадает');
  expect(() => saved({ kind: 'delete-connection', id: '20', expectedTopologyRevision: '0' })).toThrow('завершена');
  expect(captureEditorJournal(writes, '7').graph[0]).toMatchObject({ phase: 'unprepared', intent: { id: '20' } });
});

test('restored unprepared connection cannot silently select a new CAS when the user asks to retry', async () => {
  const intent = { kind: 'create-connection', commandId: '11111111-1111-4111-8111-111111111111', from: '10', to: '11', fromPort: 'right', toPort: 'left' };
  const value = { formatVersion: 2, components: [], graph: [{ phase: 'unprepared', intent, reason: '' }] };
  const fetcher = vi.fn().mockResolvedValue(reply(graph('99'))); vi.stubGlobal('fetch', fetcher);
  const { queue, transport } = restoreProjectEditorJournal(options(), value);
  const review = await queue.graph.review(7, async () => {
    const loaded = await transport.getScheme(7);
    if (!loaded.components || !loaded.connections) throw new Error('Incomplete graph');
    return { id: loaded.id, components: loaded.components, connections: loaded.connections };
  });
  const action = vi.fn();
  expect(() => queue.graph.retryConnection(review, 7, review.failures[0].id, () => true, action)).toThrow('неизвестна');
  expect(action).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(captureEditorJournal(queue, '7').graph[0].phase).toBe('unprepared');
  queue.graph.acceptServer(review, 7, new Set([review.failures[0].id]));
  expect(captureEditorJournal(queue, '7').graph).toEqual([]);
});

test('preflight snapshots include later queued work without waiting for its CAS or losing either intention', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('8'))).mockRejectedValueOnce(new TypeError('lost'));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options()), writes = new ComponentWrites(); await transport.getScheme(7);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
  const a = writes.graph.run(7, { kind: 'create-connection', commandId: first, from: 10, to: 11, fromPort: 'right', toPort: 'left' },
    capture => transport.addConnection(7, 10, 11, 'right', 'left', first, async wire => { await capture(wire); await gate; })).catch(() => {});
  const b = writes.graph.run(7, { kind: 'create-connection', commandId: second, from: 11, to: 10, fromPort: 'right', toPort: 'left' },
    capture => transport.addConnection(7, 11, 10, 'right', 'left', second, capture)).catch(() => {});
  await vi.waitFor(() => expect(captureEditorJournal(writes, '7').graph.map(entry => entry.phase)).toEqual(['prepared', 'unprepared']));
  const snapshot = captureEditorJournal(writes, '7');
  expect(snapshot.graph[0].intent).toHaveProperty('expectedTopologyRevision', '8');
  expect(snapshot.graph[1].intent).not.toHaveProperty('expectedTopologyRevision');
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(); await Promise.all([a, b]);
  expect(captureEditorJournal(writes, '7').graph.map(entry => entry.phase)).toEqual(['prepared', 'unprepared']);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
