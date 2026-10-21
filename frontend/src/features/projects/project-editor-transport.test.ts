import { afterEach, expect, test, vi } from 'vitest';
import { createProjectEditorTransport } from './project-editor-transport';

afterEach(() => vi.unstubAllGlobals());
const projectId = '9007199254740993', schemeId = '7', base = `/api/projects/${projectId}/schemes/${schemeId}`;
const command = '11111111-1111-4111-8111-111111111111';
const item = (id: string) => ({ id, typeId: '1', type: 'busbar', name: 'Шина', x: 0, y: 0, rotation: 0, revision: '1', equipmentModelId: null, params: {} });
const link = { id: '20', from: '10', to: '11', fromPort: 'right', toPort: 'left', validationErrors: [] };
const graph = (topologyRevision = '0', components = [item('10'), item('11')], connections: typeof link[] = []) => ({ id: schemeId, projectId, name: 'Private', description: '', topologyRevision, components, connections });
const reply = (data: unknown, revision?: string) => new Response(JSON.stringify(data), { headers: revision === undefined ? {} : { ETag: `"${revision}"` } });
const options = () => ({ projectId, schemeId, name: 'Private', writable: true, signal: new AbortController().signal });

test('project passport identity is captured before dispatch and retained after graph synchronization', async () => {
  const passport = '9007199254740993';
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('0', [])))
    .mockResolvedValueOnce(reply({ success: true, id: '10', revision: '1', equipmentModelId: null, projectPassportVersionId: passport, params: { power_nom: '10.00' } }, '1'))
    .mockResolvedValueOnce(reply({ ...graph('1', [item('10')]), components: [{ ...item('10'), projectPassportVersionId: passport, params: { power_nom: '10.00' } }] }));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options()); await transport.getScheme(7);
  const capture = vi.fn(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
  const created = await transport.addComponent(7, 1, 0, 0, 0, 'Источник', null, {}, capture, passport);
  expect(capture).toHaveBeenCalledWith(expect.objectContaining({ projectPassportVersionId: passport, equipmentModelId: null }));
  expect(created.projectPassportVersionId).toBe(passport);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).projectPassportVersionId).toBe(passport);
});
test('structural mutations serialize, verify the complete graph and advance only confirmed topology', async () => {
  let release!: (response: Response) => void;
  const first = new Promise<Response>(resolve => { release = resolve; });
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('0', []))).mockReturnValueOnce(first)
    .mockResolvedValueOnce(reply(graph('1', [item('10')]))).mockResolvedValueOnce(reply({ success: true, id: '11', revision: '1', equipmentModelId: null, params: {} }, '1'))
    .mockResolvedValueOnce(reply(graph('2'))).mockResolvedValueOnce(reply({ success: true, id: '20', commandId: command, deleted: false, topologyRevision: '3' }, '3'))
    .mockResolvedValueOnce(reply(graph('3', undefined, [link])));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options());
  await transport.getScheme(7);
  const add1 = transport.addComponent(7, 1, 0, 0, 0, 'Шина');
  const add2 = transport.addComponent(7, 1, 0, 0, 0, 'Шина');
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  release(reply({ success: true, id: '10', revision: '1', equipmentModelId: null, params: {} }, '1'));
  expect((await add1).id).toBe(10); expect((await add2).id).toBe(11);
  await transport.addConnection(7, 10, 11, 'right', 'left', command);
  expect(fetcher.mock.calls[5][1].headers['If-Match']).toBe('"2"');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([base, `${base}/components`, base, `${base}/components`, base, `${base}/connection-commands`, base]);
});
test('an unseen concurrent structural change cannot be silently adopted after a component acknowledgement', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('0', [])))
    .mockResolvedValueOnce(reply({ success: true, id: '10', revision: '1', equipmentModelId: null, params: {} }, '1'))
    .mockResolvedValueOnce(reply(graph('2', [item('10'), item('99')])));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options()); await transport.getScheme(7);
  await expect(transport.addComponent(7, 1, 0, 0, 0, 'Шина')).rejects.toThrow('Состав схемы изменился');
  await expect(transport.calculateScheme(7)).rejects.toThrow('топология не подтверждена');
  await expect(transport.addComponent(7, 1, 0, 0, 0, 'Шина')).rejects.toThrow('топология не подтверждена');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
test('lost connection command retains original CAS after reviewed reread; deleted history does not create an edge', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('9007199254740994'))).mockRejectedValueOnce(new TypeError('Lost acknowledgement'))
    .mockResolvedValueOnce(reply(graph('9007199254740996')))
    .mockResolvedValueOnce(reply({ success: true, id: '20', commandId: command, deleted: true, topologyRevision: '9007199254740995' }, '9007199254740995'))
    .mockResolvedValueOnce(reply(graph('9007199254740996')));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options()); await transport.getScheme(7);
  await expect(transport.addConnection(7, 10, 11, 'right', 'left', command)).rejects.toThrow('Lost acknowledgement');
  await transport.getScheme(7);
  await expect(transport.addConnection(7, 10, 11, 'left', 'left', command)).rejects.toThrow('Данные повторной команды изменены');
  expect(await transport.addConnection(7, 10, 11, 'right', 'left', command)).toEqual({ success: true, id: 20, commandId: command });
  expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[3]);
  expect((await transport.getScheme(7)).connections).toEqual([]);
});
test('viewer, foreign scheme and missing object never dispatch writes; metadata-free editor snapshot is exact', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply(graph())); vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport({ ...options(), writable: false });
  expect(await transport.getScheme(7)).toMatchObject({ id: 7, name: 'Private' });
  await expect(transport.updateComponent(10, 1, 2, 0, 'Шина', '1')).rejects.toThrow('только для чтения');
  await expect(transport.calculateScheme(7)).rejects.toThrow('только для чтения');
  await expect(transport.getScheme(8)).rejects.toThrow('контексту');
  await expect(transport.createScheme('Hidden', '')).rejects.toThrow('навигаторе');
  expect(fetcher).toHaveBeenCalledOnce();
});
test('revoked scope signals unavailability; cancellation hides late responses without reporting expired auth', async () => {
  const unavailable = vi.fn(); const controller = new AbortController();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 })); vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport({ ...options(), signal: controller.signal, onUnavailable: unavailable });
  await expect(transport.getScheme(7)).rejects.toThrow(); expect(unavailable).toHaveBeenCalledOnce();
  fetcher.mockImplementation(async () => { controller.abort(); return reply(graph()); });
  await expect(transport.getScheme(7)).rejects.toThrow(); expect(unavailable).toHaveBeenCalledOnce();
  await expect(transport.getScheme(7)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(2);
});
test('calculation uses the loaded topology and forwards source only after response validation', async () => {
  const onCalculation = vi.fn();
  const source = { projectId, schemeId, topologyRevision: '9007199254740994', inputSha256: 'a'.repeat(64), archiveId: '9007199254740995' };
  const result = { success: true, nodes: [], node_count: 0, iterations: 0, computation_time_ms: 0, method_used: 'newton-raphson' };
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph(source.topologyRevision))).mockResolvedValueOnce(new Response(JSON.stringify(result), { headers: {
    'X-Enersy-Project-Id': projectId, 'X-Enersy-Scheme-Id': schemeId, 'X-Enersy-Topology-Revision': source.topologyRevision, 'X-Enersy-Input-SHA256': source.inputSha256, 'X-Enersy-Archive-Id': source.archiveId,
  } }));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport({ ...options(), onCalculation }); await transport.getScheme(7);
  expect(await transport.calculateScheme(7)).toEqual(result); expect(onCalculation).toHaveBeenCalledWith(source);
  expect(fetcher.mock.calls[1][1].headers['If-Match']).toBe('"9007199254740994"');
  expect(fetcher.mock.calls[1][0]).toContain('/archive-calculation?');
});
test('deletion verifies incident edges and subsequent geometry uses only scoped object CAS', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(graph('3', undefined, [link])))
    .mockResolvedValueOnce(reply({ success: true, revision: '2' }, '2'))
    .mockResolvedValueOnce(reply(graph('5', [item('11')])))
    .mockResolvedValueOnce(reply({ success: true, revision: '9007199254740994' }, '9007199254740994'));
  vi.stubGlobal('fetch', fetcher);
  const transport = createProjectEditorTransport(options()); await transport.getScheme(7);
  await transport.deleteComponent(10, '1');
  await transport.patchComponent(11, { pose: { rotation: 90 }, params: { voltage_nom: '110' } }, '9007199254740993');
  await expect(transport.patchComponent(99, { pose: { x: 1 } }, '1')).rejects.toThrow('отсутствует');
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls[1]).toEqual([`${base}/components/10`, expect.objectContaining({ method: 'DELETE', headers: { 'Content-Type': 'application/json', 'If-Match': '"1"' } })]);
  expect(fetcher.mock.calls[3]).toEqual([`${base}/components/11`, expect.objectContaining({ method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': '"9007199254740993"' } })]);
});
