// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import * as api from '../../../api/ees-api';
import { useSchemeData } from './useSchemeData';
import { ComponentWrites } from '../component-writes';
import { ComponentWriteError } from '../../../api/component-revision';

vi.mock('../../../api/ees-api');
const notify = vi.hoisted(() => vi.fn());
vi.mock('../../NotificationProvider', () => ({ useNotify: () => ({ notify }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let state: ReturnType<typeof useSchemeData>;
let root: Root;
function Harness({ queue }: { queue?: ComponentWrites }) { state = useSchemeData(1, queue); return <span>{state.currentSchemeId}</span>; }
const item = { id: 1, code: 'busbar', name: 'Шина', category: 'test', description: '' };
const component = { id: 101, revision: '1', type: 'busbar', typeId: 1, name: 'Шина', x: 0, y: 0, rotation: 0, params: {} };
const result = (error: string): api.CalculationResult => ({ success: false, error, nodes: [], node_count: 0, iterations: 0, computation_time_ms: 0, method_used: 'newton-raphson' });
async function select(id: number) { await act(async () => { state.setCurrentSchemeId(id); }); }
async function settle(action: () => void) { await act(async () => { action(); }); }

beforeEach(async () => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api.getComponentTypes).mockResolvedValue([]);
  vi.mocked(api.getSchemes).mockResolvedValue([]);
  vi.mocked(api.getComponentParams).mockResolvedValue([]);
  vi.mocked(api.addComponent).mockResolvedValue({ id: 103, revision: '1', success: true, params: {}, equipmentModelId: null });
  vi.mocked(api.getScheme).mockImplementation(async id => ({ id, name: '', description: '', created_at: '', updated_at: '', owner_id: 1, components: [], connections: [] }));
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness />); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); });

test('component confirmation cannot enter another scheme, including A → B → A', async () => {
  const reply = deferred<Awaited<ReturnType<typeof api.addComponent>>>();
  vi.mocked(api.addComponent).mockReturnValue(reply.promise);
  let operation!: Promise<void>;
  await act(async () => { operation = state.addComponent(item, 10, 20); });
  expect(api.addComponent).toHaveBeenCalledWith(1, 1, 10, 20, 0, 'Шина', null);
  await select(2);
  await select(1);
  await settle(() => reply.resolve({ id: 103, revision: '1', success: true, params: {}, equipmentModelId: null }));
  await operation;
  expect(state.components).toEqual([]);
});

test('switch during parameter loading prevents a write that has not yet started', async () => {
  const reply = deferred<api.ComponentParam[]>();
  vi.mocked(api.getComponentParams).mockReturnValue(reply.promise);
  let operation!: Promise<void>;
  await act(async () => { operation = state.addComponent(item, 10, 20); });
  await select(2);
  await settle(() => reply.resolve([]));
  await operation;
  expect(api.addComponent).not.toHaveBeenCalled();
});

test('current component creation and deletion still update the graph', async () => {
  await act(async () => { await state.addComponent(item, 10, 20); });
  expect(state.components).toEqual([{ id: 103, revision: '1', type: 'busbar', typeId: 1, name: 'Шина', x: 10, y: 20, rotation: 0, params: {}, equipmentModelId: null, paramTemplate: [] }]);
  vi.mocked(api.deleteComponent).mockResolvedValue({ success: true, revision: '2' });
  await act(async () => { await state.deleteSelectedComponent(103); });
  expect(state.components).toEqual([]);
});

test('old connection deletion cannot remove a reloaded connection', async () => {
  const reply = deferred<Awaited<ReturnType<typeof api.deleteConnection>>>();
  vi.mocked(api.deleteConnection).mockReturnValue(reply.promise);
  let operation!: Promise<void>;
  await act(async () => { operation = state.deleteConnection(201); });
  await select(2);
  await select(1);
  const connection = { id: 201, from: 101, to: 102, fromPort: 'a', toPort: 'b' };
  await act(async () => { state.setConnections([connection]); });
  await settle(() => reply.resolve({ success: true }));
  await operation;
  expect(state.connections).toEqual([connection]);
  await act(async () => { await state.deleteConnection(201); });
  expect(state.connections).toEqual([]);
});

test('connection confirmation is scoped, while a current confirmation is applied', async () => {
  const reply = deferred<Awaited<ReturnType<typeof api.addConnection>>>();
  vi.mocked(api.addConnection).mockReturnValue(reply.promise);
  let operation!: Promise<void>;
  await act(async () => { operation = state.addConnection(1, 101, 102, 'a', 'b'); });
  await select(2);
  await settle(() => reply.resolve({ id: 201, success: true }));
  await operation;
  expect(state.connections).toEqual([]);
  await act(async () => { await state.addConnection(2, 301, 302, 'a', 'b'); });
  expect(state.connections).toEqual([{ id: 201, from: 301, to: 302, fromPort: 'a', toPort: 'b' }]);
  await state.addConnection(1, 101, 102, 'a', 'b');
  expect(api.addConnection).toHaveBeenCalledTimes(2);
});

test('old delete acknowledgement cannot remove freshly reloaded objects', async () => {
  const reply = deferred<Awaited<ReturnType<typeof api.deleteComponent>>>();
  vi.mocked(api.deleteComponent).mockReturnValue(reply.promise);
  let operation!: Promise<void>;
  await act(async () => { state.setComponents([component]); });
  await act(async () => { operation = state.deleteSelectedComponent(101); });
  vi.mocked(api.getScheme).mockResolvedValue({ id: 1, name: '', description: '', created_at: '', updated_at: '', owner_id: 1, components: [component], connections: [] });
  await select(2);
  await select(1);
  await act(async () => { state.setComponents([component]); });
  await settle(() => reply.resolve({ success: true, revision: '2' }));
  await operation;
  expect(state.components).toEqual([{ ...component, paramTemplate: [] }]);
});

test('network failure keeps the object and informs the user', async () => {
  vi.mocked(api.deleteComponent).mockRejectedValue(new Error('lost acknowledgement'));
  await act(async () => { state.setComponents([component]); });
  await act(async () => { await state.deleteSelectedComponent(101); });
  expect(state.components).toEqual([component]);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('Повторно загрузите'), 'error');
});

test('old calculation cannot unlock the current one or return a stale result', async () => {
  const old = deferred<api.CalculationResult>();
  const current = deferred<api.CalculationResult>();
  vi.mocked(api.calculateScheme).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  let first!: ReturnType<typeof state.handleCalculate>;
  let second!: ReturnType<typeof state.handleCalculate>;
  await act(async () => { first = state.handleCalculate(); });
  await select(2);
  expect(state.isCalculating).toBe(false);
  await act(async () => { second = state.handleCalculate(); });
  expect(state.isCalculating).toBe(true);
  expect(await state.handleCalculate()).toBeNull();
  expect(api.calculateScheme).toHaveBeenCalledTimes(2);
  await settle(() => old.resolve(result('old')));
  expect(await first).toBeNull();
  expect(state.isCalculating).toBe(true);
  await settle(() => current.resolve(result('current')));
  expect(await second).toEqual(result('current'));
  expect(state.isCalculating).toBe(false);
});

test.each(['create', 'delete', 'component'] as const)('calculation waits for dispatched %s graph mutation', async kind => {
  const reply = deferred<{ success: true; id: number; revision: string; params: Record<string, string>; equipmentModelId: null }>();
  vi.mocked(api.addConnection).mockReturnValue(reply.promise);
  vi.mocked(api.deleteConnection).mockReturnValue(reply.promise);
  vi.mocked(api.addComponent).mockReturnValue(reply.promise);
  vi.mocked(api.calculateScheme).mockResolvedValue(result('checked'));
  let operation!: Promise<void>, calculation!: ReturnType<typeof state.handleCalculate>;
  await act(async () => {
    operation = kind === 'create' ? state.addConnection(1, 101, 102, 'left', 'right')
      : kind === 'delete' ? state.deleteConnection(201) : state.addComponent(item, 10, 20);
  });
  await act(async () => { calculation = state.handleCalculate(); });
  expect(api.calculateScheme).not.toHaveBeenCalled();
  await settle(() => reply.resolve({ success: true, id: 201, revision: '1', params: {}, equipmentModelId: null }));
  await operation; await calculation;
  expect(api.calculateScheme).toHaveBeenCalledOnce();
});

test('lost graph acknowledgement blocks calculation after reopening, but not another scheme', async () => {
  vi.mocked(api.addConnection).mockRejectedValue(new Error('network'));
  await act(async () => { await state.addConnection(1, 101, 102, 'left', 'right'); });
  await select(2); await select(1);
  await act(async () => { await state.handleCalculate(); });
  expect(api.calculateScheme).not.toHaveBeenCalled();
  expect(state.calculationError).toContain('топологии');
  await select(2);
  vi.mocked(api.calculateScheme).mockResolvedValue(result('other'));
  await act(async () => { await state.handleCalculate(); });
  expect(api.calculateScheme).toHaveBeenCalledExactlyOnceWith(2, undefined, undefined);
});

test('captured view expires even when selections are batched back to the same ID', async () => {
  const isCurrent = state.captureView();
  await act(async () => { state.setCurrentSchemeId(2); state.setCurrentSchemeId(1); });
  expect(isCurrent()).toBe(false);
  expect(state.currentSchemeId).toBe(1);
});

test('unmount invalidates callbacks', async () => {
  const isCurrent = state.captureView();
  await act(async () => { root.unmount(); });
  expect(isCurrent()).toBe(false);
});

test('two moves cannot be dispatched concurrently', async () => {
  const first = deferred<Awaited<ReturnType<typeof api.updateComponent>>>();
  vi.mocked(api.updateComponent).mockReturnValueOnce(first.promise).mockResolvedValue({ success: true, revision: '2' });
  await act(async () => { state.setComponents([component]); });
  let a!: ReturnType<typeof state.updateComponentPosition>;
  let b!: ReturnType<typeof state.updateComponentPosition>;
  await act(async () => { a = state.updateComponentPosition(101, 10, 20); b = state.updateComponentPosition(101, 30, 40); });
  expect(api.updateComponent).toHaveBeenCalledTimes(1);
  await settle(() => first.resolve({ success: true, revision: '2' }));
  await Promise.all([a, b]);
  expect(api.updateComponent).toHaveBeenNthCalledWith(2, 101, 30, 40, 0, 'Шина', '2');
});

test('move and rotate preserve both edits and only one request per component is active', async () => {
  const first = deferred<Awaited<ReturnType<typeof api.updateComponent>>>();
  vi.mocked(api.updateComponent).mockReturnValueOnce(first.promise).mockResolvedValue({ success: true, revision: '2' });
  await act(async () => { state.setComponents([component]); });
  let move!: Promise<void>;
  let rotate!: Promise<void>;
  let lastMove!: Promise<void>;
  await act(async () => {
    move = state.updateComponentPosition(101, 10, 20);
    rotate = state.rotateComponent(101);
    lastMove = state.updateComponentPosition(101, 30, 40);
  });
  expect(api.updateComponent).toHaveBeenCalledTimes(1);
  expect(api.updateComponent).toHaveBeenNthCalledWith(1, 101, 10, 20, 0, 'Шина', '1');
  await settle(() => first.resolve({ success: true, revision: '2' }));
  await Promise.all([move, rotate, lastMove]);
  expect(api.updateComponent).toHaveBeenNthCalledWith(2, 101, 10, 20, 90, 'Шина', '2');
  expect(api.updateComponent).toHaveBeenNthCalledWith(3, 101, 30, 40, 90, 'Шина', '2');
  expect(state.components[0].rotation).toBe(90);
});

test('rapid rotations accumulate and independent objects do not wait for each other', async () => {
  const first = deferred<Awaited<ReturnType<typeof api.updateComponent>>>();
  vi.mocked(api.updateComponent).mockReturnValueOnce(first.promise).mockResolvedValue({ success: true, revision: '2' });
  await act(async () => { state.setComponents([component, { ...component, id: 102 }]); });
  let a!: Promise<void>;
  let b!: Promise<void>;
  let other!: Promise<void>;
  await act(async () => { a = state.rotateComponent(101); b = state.rotateComponent(101); other = state.rotateComponent(102); });
  await other;
  expect(api.updateComponent).toHaveBeenCalledTimes(2);
  expect(api.updateComponent).toHaveBeenNthCalledWith(2, 102, 0, 0, 90, 'Шина', '1');
  await settle(() => first.resolve({ success: true, revision: '2' }));
  await Promise.all([a, b]);
  expect(api.updateComponent).toHaveBeenNthCalledWith(3, 101, 0, 0, 180, 'Шина', '2');
});

test('lost acknowledgement remains blocked after reload until explicit resolution', async () => {
  const first = deferred<Awaited<ReturnType<typeof api.updateComponent>>>();
  vi.mocked(api.updateComponent).mockReturnValue(first.promise);
  await act(async () => { state.setComponents([component]); });
  let move!: Promise<void>;
  let rotate!: Promise<void>;
  await act(async () => { move = state.updateComponentPosition(101, 10, 20); rotate = state.rotateComponent(101); });
  await settle(() => first.reject(new Error('acknowledgement lost')));
  await Promise.all([move, rotate]);
  expect(api.updateComponent).toHaveBeenCalledTimes(1);
  expect(state.components[0].rotation).toBe(0);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('Повторно загрузите'), 'error');
  await act(async () => { await state.saveComponentParam(101, 'p', '20'); });
  expect(api.setComponentParam).not.toHaveBeenCalled();
  await act(async () => { expect(await state.handleCalculate()).toBeNull(); });
  expect(api.calculateScheme).not.toHaveBeenCalled();
  expect(state.calculationError).toContain('перед расчётом');
  await select(2);
  await select(1);
  await act(async () => { state.setComponents([component]); });
  vi.mocked(api.updateComponent).mockResolvedValue({ success: true, revision: '2' });
  await act(async () => { await state.rotateComponent(101); });
  expect(api.updateComponent).toHaveBeenCalledTimes(1);
  expect(state.failedDrafts[0].intents).toEqual([
    { kind: 'pose', values: { x: 10, y: 20 } },
    { kind: 'pose', values: { rotation: 90 } },
    { kind: 'parameter', key: 'p', value: '20' },
    { kind: 'pose', values: { rotation: 90 } },
  ]);
});

test('reload waits for dispatched write and drops stale queued intents', async () => {
  const first = deferred<Awaited<ReturnType<typeof api.updateComponent>>>();
  vi.mocked(api.updateComponent).mockReturnValue(first.promise);
  await act(async () => { state.setComponents([component]); });
  let move!: Promise<void>;
  let rotate!: Promise<void>;
  await act(async () => { move = state.updateComponentPosition(101, 10, 20); rotate = state.rotateComponent(101); });
  vi.mocked(api.getScheme).mockClear();
  await select(2);
  await select(1);
  expect(api.getScheme).not.toHaveBeenCalled();
  await settle(() => first.resolve({ success: true, revision: '2' }));
  await Promise.all([move, rotate]);
  expect(api.updateComponent).toHaveBeenCalledTimes(1);
  expect(api.getScheme).toHaveBeenCalledTimes(1);
  expect(api.getScheme).toHaveBeenCalledWith(1);
  expect(state.components).toEqual([]);
});

test('parameters and delete use the same object queue', async () => {
  const first = deferred<Awaited<ReturnType<typeof api.setComponentParam>>>();
  vi.mocked(api.setComponentParam).mockReturnValueOnce(first.promise).mockResolvedValue({ success: true, revision: '2' });
  vi.mocked(api.deleteComponent).mockResolvedValue({ success: true, revision: '2' });
  await act(async () => { state.setComponents([component]); });
  let a!: Promise<void>;
  let b!: Promise<void>;
  let deletion!: Promise<void>;
  await act(async () => { a = state.saveComponentParam(101, 'p', '10'); b = state.saveComponentParam(101, 'p', '20'); deletion = state.deleteSelectedComponent(101); });
  expect(api.setComponentParam).toHaveBeenCalledTimes(1);
  expect(api.deleteComponent).not.toHaveBeenCalled();
  await settle(() => first.resolve({ success: true, revision: '2' }));
  await Promise.all([a, b, deletion]);
  expect(api.setComponentParam).toHaveBeenNthCalledWith(2, 101, 'p', '20', '2');
  expect(api.deleteComponent).toHaveBeenCalledTimes(1);
  expect(state.components).toEqual([]);
});

test('calculation waits for acknowledged parameter writes', async () => {
  const write = deferred<Awaited<ReturnType<typeof api.setComponentParam>>>();
  const laterWrite = deferred<Awaited<ReturnType<typeof api.setComponentParam>>>();
  vi.mocked(api.setComponentParam).mockReturnValueOnce(write.promise).mockReturnValueOnce(laterWrite.promise);
  vi.mocked(api.calculateScheme).mockResolvedValue(result('test'));
  await act(async () => { state.setComponents([component]); });
  let parameter!: Promise<void>;
  let calculation!: ReturnType<typeof state.handleCalculate>;
  await act(async () => { parameter = state.saveComponentParam(101, 'p', '20'); calculation = state.handleCalculate(); });
  expect(api.calculateScheme).not.toHaveBeenCalled();
  let later!: Promise<void>;
  await act(async () => { later = state.saveComponentParam(101, 'p', '30'); });
  await settle(() => write.resolve({ success: true, revision: '2' }));
  await parameter;
  expect(api.calculateScheme).not.toHaveBeenCalled();
  await settle(() => laterWrite.resolve({ success: true, revision: '2' }));
  await later;
  expect(await calculation).toEqual(result('test'));
  expect(api.calculateScheme).toHaveBeenCalledTimes(1);
});

test('application-owned queue survives editor unmount and remount', async () => {
  const queue = new ComponentWrites();
  await act(async () => { root.unmount(); });
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness queue={queue} />); });
  const reply = deferred<Awaited<ReturnType<typeof api.updateComponent>>>();
  vi.mocked(api.updateComponent).mockReturnValue(reply.promise);
  await act(async () => { state.setComponents([component]); });
  let operation!: Promise<void>;
  await act(async () => { operation = state.updateComponentPosition(101, 10, 20); });
  await act(async () => { root.unmount(); });
  vi.mocked(api.getScheme).mockClear();
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness queue={queue} />); });
  expect(api.getScheme).not.toHaveBeenCalled();
  await settle(() => reply.resolve({ success: true, revision: '2' }));
  await operation;
  expect(api.getScheme).toHaveBeenCalledTimes(1);
});

test('queued geometry, parameters and delete advance using server revisions', async () => {
  const first = deferred<Awaited<ReturnType<typeof api.updateComponent>>>();
  vi.mocked(api.updateComponent).mockReturnValue(first.promise);
  vi.mocked(api.setComponentParam).mockResolvedValue({ success: true, revision: '9007199254740995' });
  vi.mocked(api.deleteComponent).mockResolvedValue({ success: true, revision: '9007199254740995' });
  await act(async () => { state.setComponents([{ ...component, revision: '9007199254740993' }]); });
  let move!: Promise<void>, parameter!: Promise<void>, deletion!: Promise<void>;
  await act(async () => {
    move = state.updateComponentPosition(101, 10, 20);
    parameter = state.saveComponentParam(101, 'p', '10');
    deletion = state.deleteSelectedComponent(101);
  });
  expect(api.updateComponent).toHaveBeenCalledWith(101, 10, 20, 0, 'Шина', '9007199254740993');
  expect(api.setComponentParam).not.toHaveBeenCalled();
  await settle(() => first.resolve({ success: true, revision: '9007199254740994' }));
  await Promise.all([move, parameter, deletion]);
  expect(api.setComponentParam).toHaveBeenCalledWith(101, 'p', '10', '9007199254740994');
  expect(api.deleteComponent).toHaveBeenCalledWith(101, '9007199254740995');
  expect(state.components).toEqual([]);
});

test('a no-op parameter keeps the acknowledged revision for the next write', async () => {
  vi.mocked(api.setComponentParam).mockResolvedValue({ success: true, revision: '1' });
  vi.mocked(api.updateComponent).mockResolvedValue({ success: true, revision: '2' });
  await act(async () => { state.setComponents([component]); });
  await act(async () => { await state.saveComponentParam(101, 'p', '10'); });
  await act(async () => { await state.rotateComponent(101); });
  expect(api.updateComponent).toHaveBeenCalledWith(101, 0, 0, 90, 'Шина', '1');
  expect(state.components[0].revision).toBe('2');
});

test('conflict stops queued writes and calculation without silently retrying', async () => {
  vi.mocked(api.updateComponent).mockRejectedValue(new ComponentWriteError('Оборудование изменено другим клиентом. Сравните изменения', 412, 'component_revision_conflict'));
  await act(async () => { state.setComponents([{ ...component, x: 10, y: 20 }]); });
  await act(async () => { await Promise.all([state.rotateComponent(101), state.saveComponentParam(101, 'p', '20')]); });
  expect(api.updateComponent).toHaveBeenCalledTimes(1);
  expect(api.setComponentParam).not.toHaveBeenCalled();
  expect(state.components[0]).toMatchObject({ revision: '1', x: 10, y: 20, params: {} });
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('другим клиентом'), 'error');
  await act(async () => { expect(await state.handleCalculate()).toBeNull(); });
  expect(api.calculateScheme).not.toHaveBeenCalled();
});

test('invalid revision acknowledgement stops subsequent object writes', async () => {
  vi.mocked(api.updateComponent).mockResolvedValue({ success: true, revision: '01' });
  await act(async () => { state.setComponents([component]); });
  await act(async () => { await state.rotateComponent(101); });
  await act(async () => { await state.saveComponentParam(101, 'p', '20'); });
  expect(api.setComponentParam).not.toHaveBeenCalled();
  expect(state.components[0].revision).toBe('1');
});

async function failMove() {
  vi.mocked(api.updateComponent).mockRejectedValue(new Error('conflict'));
  await act(async () => { state.setComponents([component]); });
  await act(async () => { await state.updateComponentPosition(101, 20, 30); });
  return state.failedDrafts[0];
}

test('parameter recovery resets only reviewed inputs after confirmation and not after a rejected write', async () => {
  await act(async () => { state.setComponents([component]); });
  vi.mocked(api.setComponentParam).mockRejectedValue(new Error('conflict'));
  await act(async () => { await state.saveComponentParam(101, 'u', '750'); });
  const draft = state.failedDrafts[0];
  const server = { ...component, revision: '8', params: { u: '500', i: '2000' } };
  vi.mocked(api.patchComponent).mockRejectedValue(new Error('412 conflict'));
  await act(async () => { await expect(state.resolveComponentDraft(draft, server, new Set(['parameter:u']), 'apply')).rejects.toThrow('412'); });
  expect(state.parameterResets).toEqual({});
  await act(async () => { await state.resolveComponentDraft(draft, server, new Set(['parameter:u']), 'accept'); });
  expect(state.parameterResets).toEqual({ 101: { u: 1 } });
  expect(state.components[0].params).toEqual(server.params);
  expect(state.failedDrafts).toEqual([]);
  await select(2);
  expect(state.parameterResets).toEqual({});
});

test('partial recovery updates confirmed graph and preserves remaining conflicts until accepted', async () => {
  const draft = await failMove();
  vi.mocked(api.patchComponent).mockResolvedValue({ success: true, revision: '9' });
  const server = { ...component, revision: '8', x: 100, y: 200, name: 'Server' };
  await act(async () => { await state.resolveComponentDraft(draft, server, new Set(['pose:x']), 'apply'); });
  expect(api.patchComponent).toHaveBeenCalledWith(101, { pose: { x: 20 } }, '8');
  expect(state.components[0]).toMatchObject({ revision: '9', x: 20, y: 200, name: 'Server' });
  expect(state.failedDrafts[0].intents).toEqual([{ kind: 'pose', values: { y: 30 } }]);
  await act(async () => { await state.handleCalculate(); });
  expect(api.calculateScheme).not.toHaveBeenCalled();
  await act(async () => { await state.resolveComponentDraft(state.failedDrafts[0], { ...server, x: 20, revision: '9' }, new Set(['pose:y']), 'accept'); });
  expect(state.failedDrafts).toEqual([]);
  expect(api.patchComponent).toHaveBeenCalledTimes(1);
  vi.mocked(api.updateComponent).mockResolvedValue({ success: true, revision: '10' });
  await act(async () => { await state.rotateComponent(101); });
  expect(api.updateComponent).toHaveBeenLastCalledWith(101, 20, 200, 90, 'Server', '9');
});

test('failed recovery keeps graph and intent, and confirmation cannot enter another opening', async () => {
  const draft = await failMove();
  vi.mocked(api.patchComponent).mockRejectedValue(new Error('412 conflict'));
  await act(async () => { await expect(state.resolveComponentDraft(draft, { ...component, revision: '8' }, new Set(['pose:x']), 'apply')).rejects.toThrow('412'); });
  expect(state.components[0].revision).toBe('1');
  expect(state.failedDrafts[0].intents).toHaveLength(1);
  const reply = deferred<api.ComponentWriteResult>();
  vi.mocked(api.patchComponent).mockReturnValue(reply.promise);
  let operation!: Promise<void>;
  await act(async () => { operation = state.resolveComponentDraft(state.failedDrafts[0], { ...component, revision: '8' }, new Set(['pose:x', 'pose:y']), 'apply'); });
  await select(2);
  await settle(() => reply.resolve({ success: true, revision: '9' }));
  await operation;
  expect(state.currentSchemeId).toBe(2);
  expect(state.components).toEqual([]);
  await select(1);
  expect(state.failedDrafts).toEqual([]);
});

async function failDelete() {
  vi.mocked(api.deleteComponent).mockRejectedValue(new Error('conflict'));
  await act(async () => { state.setComponents([component, { ...component, id: 102 }]); state.setConnections([
    { id: 201, from: 101, to: 102, fromPort: 'a', toPort: 'b' },
    { id: 202, from: 102, to: 103, fromPort: 'a', toPort: 'b' },
  ]); });
  await act(async () => { await state.deleteSelectedComponent(101); });
  return state.failedDrafts[0];
}

test('confirmed deletion removes only its object and incident connections, keeping failed field intents', async () => {
  await failDelete();
  await act(async () => { await state.saveComponentParam(101, 'p', '20'); });
  vi.mocked(api.deleteComponent).mockResolvedValue({ success: true, revision: '8' });
  await act(async () => { await state.resolveComponentDeletion(state.failedDrafts[0], { ...component, revision: '8' }, 'delete'); });
  expect(api.deleteComponent).toHaveBeenLastCalledWith(101, '8');
  expect(state.components.map(item => item.id)).toEqual([102]);
  expect(state.connections.map(item => item.id)).toEqual([202]);
  expect(state.failedDrafts[0].intents).toEqual([{ kind: 'parameter', key: 'p', value: '20' }]);
  await act(async () => { await state.handleCalculate(); });
  expect(api.calculateScheme).not.toHaveBeenCalled();
});

test('retaining the server object makes no new DELETE and uses the accepted revision', async () => {
  const draft = await failDelete();
  vi.mocked(api.deleteComponent).mockClear();
  await act(async () => { await state.resolveComponentDeletion(draft, { ...component, revision: '8', x: 100 }, 'keep'); });
  expect(api.deleteComponent).not.toHaveBeenCalled();
  expect(state.connections).toHaveLength(2);
  expect(state.failedDrafts).toEqual([]);
  expect(state.components[0]).toMatchObject({ revision: '8', x: 100 });
  vi.mocked(api.updateComponent).mockResolvedValue({ success: true, revision: '9' });
  await act(async () => { await state.rotateComponent(101); });
  expect(api.updateComponent).toHaveBeenCalledWith(101, 100, 0, 90, 'Шина', '8');
});
