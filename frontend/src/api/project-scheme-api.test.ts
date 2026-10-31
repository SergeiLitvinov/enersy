import { afterEach, expect, test, vi } from 'vitest';
import { calculateProjectScheme, createProjectComponent, createProjectConnection, deleteProjectComponent, deleteProjectConnection,
  patchProjectComponent, setProjectComponentParam, updateProjectComponent } from './project-scheme-api';
import { ComponentWriteError } from './component-revision';

afterEach(() => vi.unstubAllGlobals());
const scope = { projectId: '9007199254740993', schemeId: '7' };
const base = '/api/projects/9007199254740993/schemes/7';
const signal = new AbortController().signal;
const command = '11111111-1111-4111-8111-111111111111';
const revision = '9007199254740994';
const input = { from: '10', to: '11', fromPort: 'right', toPort: 'left' };
function reply(data: unknown, token = revision, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { headers: { ETag: `"${token}"`, ...extra } });
}
test('equipment commands remain in the exact parent scope with cookie, cancellation and object CAS', async () => {
  const fetcher = vi.fn().mockImplementation(async () => reply({ success: true, revision }));
  vi.stubGlobal('fetch', fetcher);
  const pose = { x: 1, y: 2, rotation: 90, name: 'Шина' };
  await updateProjectComponent(scope, '10', pose, revision, signal);
  await patchProjectComponent(scope, '10', { params: { voltage_nom: '110' } }, revision, signal);
  await setProjectComponentParam(scope, '10', 'voltage_nom', '110', revision, signal);
  await deleteProjectComponent(scope, '10', revision, signal);
  expect(fetcher.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
    [`${base}/components/10`, 'PUT'], [`${base}/components/10`, 'PATCH'], [`${base}/components/10/params`, 'POST'], [`${base}/components/10`, 'DELETE'],
  ]);
  for (const [, options] of fetcher.mock.calls) {
    expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', signal, headers: { 'If-Match': `"${revision}"` } });
  }
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(pose);
  expect(fetcher.mock.calls[3][1].body).toBeUndefined();
});
test('creation retains string IDs, confirmed passport and safely copied parameter keys', async () => {
  const params = JSON.parse('{"voltage_nom":"110","__proto__":"declared"}');
  const fetcher = vi.fn().mockResolvedValue(reply({ success: true, id: '10', equipmentModelId: '12', params, revision }));
  vi.stubGlobal('fetch', fetcher);
  const draft = { typeId: '1', equipmentModelId: '12', x: 0, y: 0, rotation: 0, name: 'Шина', params };
  const created = await createProjectComponent(scope, draft, signal);
  expect(created.id).toBe('10'); expect(created.revision).toBe(revision); expect(created.equipmentModelId).toBe('12');
  expect(Object.prototype.hasOwnProperty.call(created.params, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(created.params)).toBe(Object.prototype);
  expect(fetcher.mock.calls[0][0]).toBe(`${base}/components`);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(draft);
});
test('numeric, mismatched or incomplete creation acknowledgements never become objects', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const override of [{ id: 10 }, { id: '2147483648' }, { equipmentModelId: '13' }, { revision: 2 }, { params: { x: 1 } }, { success: false }]) {
    fetcher.mockResolvedValue(reply({ success: true, id: '10', equipmentModelId: '12', params: {}, revision, ...override }));
    await expect(createProjectComponent(scope, { typeId: '1', equipmentModelId: '12', x: 0, y: 0, rotation: 0, name: 'Шина', params: {} }, signal)).rejects.toThrow();
  }
});

test('creation confirms an exact project passport BIGINT and rejects substitutions or two sources', async () => {
  const projectPassportVersionId = '9007199254740993';
  const draft = { typeId: '1', equipmentModelId: null, projectPassportVersionId, x: 0, y: 0, rotation: 0, name: 'Источник', params: {} };
  const ack = { success: true, id: '10', revision, equipmentModelId: null, projectPassportVersionId, params: { power_nom: '10.00' } };
  const fetcher = vi.fn().mockResolvedValue(reply(ack)); vi.stubGlobal('fetch', fetcher);
  expect((await createProjectComponent(scope, draft, signal)).projectPassportVersionId).toBe(projectPassportVersionId);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(draft);
  for (const value of [null, undefined, 12, '9007199254740994']) {
    fetcher.mockResolvedValue(reply({ ...ack, projectPassportVersionId: value }));
    await expect(createProjectComponent(scope, draft, signal)).rejects.toThrow();
  }
  fetcher.mockClear();
  await expect(createProjectComponent(scope, { ...draft, equipmentModelId: '1' }, signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
test('a repeated connection retains command, payload and original CAS; deleted replay stays explicit', async () => {
  const fetcher = vi.fn().mockImplementation(async () => reply({ success: true, id: '20', commandId: command, deleted: true, topologyRevision: revision }));
  vi.stubGlobal('fetch', fetcher);
  const first = await createProjectConnection(scope, input, command, '0', signal);
  const second = await createProjectConnection(scope, input, command, '0', signal);
  expect(first).toEqual(second); expect(first.deleted).toBe(true);
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  expect(fetcher.mock.calls[0]).toEqual([`${base}/connection-commands`, expect.objectContaining({
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command, 'If-Match': '"0"' }, body: JSON.stringify(input),
  })]);
});
test('connections require command identity, deletion state, lossless topology and matching ETag', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const override of [{ commandId: '22222222-2222-4222-8222-222222222222' }, { deleted: undefined }, { topologyRevision: 4 }, { topologyRevision: '9223372036854775808' }, { id: 20 }]) {
    fetcher.mockResolvedValue(reply({ success: true, id: '20', commandId: command, deleted: false, topologyRevision: revision, ...override }));
    await expect(createProjectConnection(scope, input, command, revision, signal)).rejects.toThrow();
  }
  fetcher.mockResolvedValue(reply({ success: true, topologyRevision: revision }, '1'));
  await expect(deleteProjectConnection(scope, '20', revision, signal)).rejects.toThrow('ETag');
  fetcher.mockResolvedValue(reply({ success: true, topologyRevision: revision }));
  expect(await deleteProjectConnection(scope, '20', revision, signal)).toEqual({ success: true, topologyRevision: revision });
});
test('denied, conflicting and lost replies make exactly one request without legacy fallback or retry', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const status of [401, 404, 409, 412]) {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: 'Refused', code: 'topology_revision_conflict' }), { status }));
    const failure = await createProjectConnection(scope, input, command, revision, signal).catch(error => error);
    expect(failure).toBeInstanceOf(ComponentWriteError); expect(failure.status).toBe(status);
  }
  fetcher.mockRejectedValue(new TypeError('Lost acknowledgement'));
  await expect(createProjectConnection(scope, input, command, revision, signal)).rejects.toThrow('Lost acknowledgement');
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(fetcher.mock.calls.every(([url]) => url === `${base}/connection-commands`)).toBe(true);
});
test('aborted scope and invalid identifiers never dispatch; abortion during decode cannot confirm a write', async () => {
  const controller = new AbortController(); controller.abort();
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(deleteProjectConnection(scope, '20', revision, controller.signal)).rejects.toThrow();
  await expect(deleteProjectConnection({ ...scope, projectId: '../2' }, '20', revision, signal)).rejects.toThrow();
  await expect(deleteProjectConnection(scope, '2147483648', revision, signal)).rejects.toThrow();
  await expect(deleteProjectConnection(scope, '20', '-1', signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  const live = new AbortController();
  fetcher.mockResolvedValue({ ok: true, json: async () => { live.abort(); return { success: true, revision }; } });
  await expect(deleteProjectComponent(scope, '10', revision, live.signal)).rejects.toThrow();
});
const result = { input_unit_contract: { formatVersion: 1, profile: 'legacy-ac-three-phase-rms-v1', validation_scope: 'request-declarations-only', component_count: 0, parameter_count: 0 }, success: true, nodes: [], node_count: 0, iterations: 0, computation_time_ms: 0, method_used: 'newton-raphson' };
const provenance = { 'X-Enersy-Project-Id': scope.projectId, 'X-Enersy-Scheme-Id': scope.schemeId,
  'X-Enersy-Topology-Revision': revision, 'X-Enersy-Input-SHA256': 'a'.repeat(64) };

test('private direct calculation refuses success without strict-unit acknowledgement', async () => {
  const { input_unit_contract: omitted, ...unchecked } = result;
  expect(omitted).toBeDefined();
  const fetcher = vi.fn().mockResolvedValue(reply(unchecked, revision, provenance)); vi.stubGlobal('fetch', fetcher);
  await expect(calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal)).rejects.toThrow('не подтвердил проверку единиц');
  expect(fetcher.mock.calls[0][0]).toContain('unitContract=legacy-ac-three-phase-rms-v1');
});

test('explicit operating limits use a body and must be confirmed before returning a project result',async()=>{
  const limits=[{component_id:2,terminal:1,min_kv:9.5,max_kv:10.5}];
  const fetcher=vi.fn().mockResolvedValue(reply(result,revision,provenance));vi.stubGlobal('fetch',fetcher);
  await expect(calculateProjectScheme(scope,revision,'newton-raphson','three-phase',signal,false,undefined,undefined,limits)).rejects.toThrow('не подтвердил');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({operatingLimits:limits});
  expect(fetcher.mock.calls[0][1].headers['If-Match']).toBe(`"${revision}"`);
  const assessment={schema_version:1,policy:'explicit-terminal-voltage-v1',stability_assessed:false,status:'violated',checks:[{component_id:2,terminal:1,bus_id:1,min:9.5,max:10.5,measured:9,status:'below_min',unit:'kV',quantity:'line_to_line_rms_voltage'}]};
  const confirmed={...result,node_count:1,nodes:[{node_id:1,node_type:'pq',voltage:9,angle:0,phase:9,quadrature:0}],operating_assessment:assessment};
  fetcher.mockResolvedValue(reply(confirmed,revision,provenance));
  expect((await calculateProjectScheme(scope,revision,'newton-raphson','three-phase',signal,false,undefined,undefined,limits)).result).toEqual(confirmed);
});

test('time budget is carried in query, checked in reply and invalid values never dispatch', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const invalid of [0, NaN, 20001, 1.5]) await expect(calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal, false, undefined, invalid)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(reply(result, revision, provenance));
  await expect(calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal, false, undefined, 5000)).rejects.toThrow('не подтвердил');
  const confirmed = { ...result, solver: { execution: { policy: 'cooperative-checkpoints-v1', max_time_ms: 5000, native_calls_interruptible: false, disconnect_cancels: false } } };
  fetcher.mockResolvedValue(reply(confirmed, revision, provenance));
  expect((await calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal, false, undefined, 5000)).result).toEqual(confirmed);
  expect(fetcher.mock.calls[1][0]).toBe(`${base}/calculate?modelGroup=three-phase&method=newton-raphson&unitContract=legacy-ac-three-phase-rms-v1&maxTimeMs=5000`);
});

test('explicit backend reaches the project query and cannot silently fall back', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  fetcher.mockResolvedValue(reply(result, revision, provenance));
  await expect(calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal, false, 'julia-rust-jacobian')).rejects.toThrow('не подтвердил');
  const actual = { ...result, solver: { compute_backend: { id: 'julia', version: '0.1.0', julia_version: '1.10.12', jacobian: 'julia', linear_solver: 'umfpack' } } };
  fetcher.mockResolvedValue(reply(actual, revision, provenance));
  await expect(calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal, false, 'julia-rust-jacobian')).rejects.toThrow('не подтвердил');
  expect(fetcher.mock.calls[0][0]).toBe(`${base}/calculate?modelGroup=three-phase&method=newton-raphson&unitContract=legacy-ac-three-phase-rms-v1&computeBackend=julia-rust-jacobian`);
  expect(fetcher.mock.calls).toHaveLength(2);
});
test('calculation requires exact snapshot provenance and explicit query; request body is empty', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply(result, revision, provenance)); vi.stubGlobal('fetch', fetcher);
  expect(await calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal)).toEqual({ result,
    source: { ...scope, topologyRevision: revision, inputSha256: 'a'.repeat(64) } });
  expect(fetcher.mock.calls[0]).toEqual([`${base}/calculate?modelGroup=three-phase&method=newton-raphson&unitContract=legacy-ac-three-phase-rms-v1`, expect.objectContaining({
    method: 'POST', headers: { 'If-Match': `"${revision}"` }, credentials: 'same-origin', cache: 'no-store', signal,
  })]);
  expect(fetcher.mock.calls[0][1].body).toBeUndefined();
  for (const key of Object.keys(provenance)) {
    fetcher.mockResolvedValue(reply(result, revision, { ...provenance, [key]: 'wrong' }));
    await expect(calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal)).rejects.toThrow('происхождение');
  }
  fetcher.mockResolvedValue(reply({ success: false, error: 'unsupported', error_detail: { message: 'Unsupported physics' } }, revision, provenance));
  await expect(calculateProjectScheme(scope, revision, 'newton-raphson', 'three-phase', signal)).rejects.toThrow('Unsupported physics');
});
