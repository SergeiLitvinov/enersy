import { expect, test, vi } from 'vitest';
import fixtureJSON from '../../../tests/fixtures/editor-draft-v1.json?raw';
import phasesJSON from '../../../tests/fixtures/editor-draft-v2.json?raw';
import { createProject, createProjectScheme, listProjects, login, logout, readProjectScheme } from './projects-api';
import { deleteEditorDraft, listEditorDrafts, readEditorDraft, saveEditorDraft } from './editor-drafts-api';
import { parseEditorDraftPayload } from './editor-draft-payload';
import { parseEditorDraftPayloadV2 } from './editor-draft-phases';
import { createProjectComponent } from './project-scheme-api';
import { getComponentTypes, type ComponentPatch } from './ees-api';
import { ComponentWrites } from '../components/ees/component-writes';
import { captureEditorJournal, restoreProjectEditorJournal } from '../features/projects/editor-journal';
import { createProjectEditorTransport } from '../features/projects/project-editor-transport';
import { compareComponentDraft } from '../components/ees/component-comparison';
import type { SchemeTransport } from '../components/ees/scheme-transport';

// Enabled only by the disposable Compose service. No configurable production URL.
test.skipIf(import.meta.env.VITE_DRAFT_HTTP_ACCEPTANCE !== '1')('real private draft client survives sessions, CAS conflicts and lost acknowledgement', async () => {
  const originalFetch = globalThis.fetch;
  const { createHttpSessionContext } = await import('../test/http-session-context.mjs');
  const sessions = createHttpSessionContext();
  const jars = ['', '', ''];
  let active = 0, loseNextPut = false, loseNextConnection = false, loseNextParameter = false;
  const paths: string[] = [];
  const connectionRequests: { body: BodyInit | null | undefined; revision: string | null; commandId: string | null }[] = [];
  const parameterRequests: { session: number; body: BodyInit | null | undefined; revision: string | null; status: number }[] = [];
  vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
    if (!path.startsWith('/api/')) throw new Error('Acceptance request escaped API');
    paths.push(path);
    const jar = sessions.getStore() ?? active;
    const headers = new Headers(options?.headers);
    headers.set('Origin', 'http://localhost:4174');
    if (jars[jar]) headers.set('Cookie', jars[jar]);
    if (path.endsWith('/connection-commands')) connectionRequests.push({ body: options?.body, revision: headers.get('If-Match'), commandId: headers.get('Idempotency-Key') });
    const response = await originalFetch(`http://go-api:8080${path}`, { ...options, headers });
    const cookie = response.headers.get('Set-Cookie');
    if (cookie) jars[jar] = cookie.split(';')[0];
    if (options?.method === 'PATCH' && /\/components\/[1-9][0-9]*$/.test(path)) {
      parameterRequests.push({ session: jar, body: options.body, revision: headers.get('If-Match'), status: response.status });
      if (loseNextParameter) {
        loseNextParameter = false;
        expect(response.status).toBe(200);
        await response.body?.cancel();
        throw new TypeError('Acceptance: value/unit acknowledgement lost');
      }
    }
    if (loseNextPut && options?.method === 'PUT') {
      loseNextPut = false;
      expect(response.status).toBe(200);
      await response.body?.cancel();
      throw new TypeError('Acceptance: committed acknowledgement lost');
    }
    if (loseNextConnection && path.endsWith('/connection-commands')) {
      loseNextConnection = false;
      expect(response.ok).toBe(true);
      await response.body?.cancel();
      throw new TypeError('Acceptance: connection acknowledgement lost');
    }
    return response;
  });
  const signal = AbortSignal.timeout(30000);
  try {
    const first = await login(import.meta.env.VITE_DRAFT_HTTP_LOGIN_A, import.meta.env.VITE_DRAFT_HTTP_PASSWORD, signal);
    active = 1;
    const second = await login(import.meta.env.VITE_DRAFT_HTTP_LOGIN_A, import.meta.env.VITE_DRAFT_HTTP_PASSWORD, signal);
    active = 2;
    const other = await login(import.meta.env.VITE_DRAFT_HTTP_LOGIN_B, import.meta.env.VITE_DRAFT_HTTP_PASSWORD, signal);
    expect(first.accountId).toBe(second.accountId); expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.accountId).not.toBe(other.accountId);
    active = 0;
    await createProject('Disposable draft client project', signal);
    const projectId = (await listProjects(signal)).items[0].id;
    const schemeId = await createProjectScheme(projectId, 'Private journal fixture', '', signal);
    const scope = { projectId, schemeId };
    const before = await readProjectScheme(projectId, schemeId, signal);
    const workspace = '22222222-2222-4222-8222-222222222222';
    const payload = parseEditorDraftPayload(JSON.parse(fixtureJSON));
    expect((await saveEditorDraft(scope, workspace, '0', payload, signal)).revision).toBe('1');
    active = 1;
    expect((await readEditorDraft(scope, workspace, signal)).payload).toEqual(payload);
    expect(await listEditorDrafts(scope, signal)).toMatchObject([{ workspaceId: workspace, revision: '1' }]);
    active = 2;
    await expect(readEditorDraft(scope, workspace, signal)).rejects.toMatchObject({ status: 404 });
    await expect(saveEditorDraft(scope, workspace, '0', payload, signal)).rejects.toMatchObject({ status: 404 });


    active = 0;
    loseNextPut = true;
    const count = paths.length;
    await expect(saveEditorDraft(scope, workspace, '1', payload, signal)).rejects.toThrow('acknowledgement lost');
    expect(paths).toHaveLength(count + 1);
    active = 1;
    const recovered = await readEditorDraft(scope, workspace, signal);
    expect(recovered.revision).toBe('2'); expect(recovered.payload).toEqual(payload);
    await expect(saveEditorDraft(scope, workspace, '1', payload, signal)).rejects.toMatchObject({ status: 412 });
    expect(await readProjectScheme(projectId, schemeId, signal)).toEqual(before);
    expect((await deleteEditorDraft(scope, workspace, '2', signal)).revision).toBe('3');
    await expect(readEditorDraft(scope, workspace, signal)).rejects.toMatchObject({ status: 404 });
    await expect(saveEditorDraft(scope, workspace, '0', payload, signal)).rejects.toMatchObject({ status: 404 });
    const phaseWorkspace = '44444444-4444-4444-8444-444444444444';
    const phases = parseEditorDraftPayloadV2(JSON.parse(phasesJSON));
    await saveEditorDraft(scope, phaseWorkspace, '0', phases, signal);
    expect((await readEditorDraft(scope, phaseWorkspace, signal)).payload).toEqual(phases);
    expect(await readProjectScheme(projectId, schemeId, signal)).toEqual(before);
    await deleteEditorDraft(scope, phaseWorkspace, '1', signal);

    // Exercise the actual queues and transport, not a hand-built wire payload.
    const type = (await getComponentTypes()).find(item => item.code === 'busbar');
    if (!type) throw new Error('Missing fixture busbar type');
    const created = [];
    for (let i = 0; i < 2; i++) created.push(await createProjectComponent(scope, { typeId: String(type.id), equipmentModelId: null,
      name: `Journal bus ${i}`, x: i * 100, y: 0, rotation: 0, params: { voltage_nom: '110' } }, signal));
    const transportOptions = { ...scope, name: 'Private journal fixture', writable: true, signal };
    const initial = createProjectEditorTransport(transportOptions), writes = new ComponentWrites();
    await initial.getScheme(Number(schemeId));
    const from = Number(created[0].id), to = Number(created[1].id), commandId = '11111111-1111-4111-8111-111111111111';
    loseNextConnection = true;
    await expect(writes.graph.run(Number(schemeId), { kind: 'create-connection', commandId, from, to, fromPort: 'right', toPort: 'left' },
      capture => initial.addConnection(Number(schemeId), from, to, 'right', 'left', commandId, capture))).rejects.toThrow('connection acknowledgement lost');
    const journal = captureEditorJournal(writes, schemeId);
    expect(journal.graph).toHaveLength(1);
    const durableWorkspace = '33333333-3333-4333-8333-333333333333';
    const committedGraph = await readProjectScheme(projectId, schemeId, signal);
    await saveEditorDraft(scope, durableWorkspace, '0', journal, signal);
    const stored = await readEditorDraft(scope, durableWorkspace, signal);
    expect(await readProjectScheme(projectId, schemeId, signal)).toEqual(committedGraph);
    const restored = restoreProjectEditorJournal(transportOptions, stored.payload);
    expect(() => restored.queue.assertConfirmed(Number(schemeId))).toThrow();
    const review = await restored.queue.graph.review(Number(schemeId), async () => {
      const loaded = await restored.transport.getScheme(Number(schemeId));
      if (!loaded.components || !loaded.connections) throw new Error('Incomplete restored graph');
      expect(loaded.connections).toHaveLength(1);
      return { id: loaded.id, components: loaded.components, connections: loaded.connections };
    });
    await restored.queue.graph.retryConnection(review, Number(schemeId), review.failures[0].id, () => true,
      intent => restored.transport.addConnection(Number(schemeId), intent.from, intent.to, intent.fromPort, intent.toPort, intent.commandId),
      async () => { await restored.transport.getScheme(Number(schemeId)); });
    expect(connectionRequests).toHaveLength(2);
    expect(connectionRequests[0]).toEqual(connectionRequests[1]);
    expect(await readProjectScheme(projectId, schemeId, signal)).toEqual(committedGraph);
    expect(captureEditorJournal(restored.queue, schemeId).graph).toEqual([]);
    expect(() => restored.queue.assertConfirmed(Number(schemeId))).not.toThrow();
    await deleteEditorDraft(scope, durableWorkspace, '1', signal);

    // Two real independent sessions see the same object; stale data cannot be
    // restored under a peer's new unit, even when a journal survives a reload.
    active = 0;
    const sid = Number(schemeId), cid = Number(created[0].id);
    const readUnitComponent = async (transport: SchemeTransport, componentId = cid) => {
      const component = (await transport.getScheme(sid)).components?.find(item => item.id === componentId);
      if (!component) throw new Error('Missing private unit fixture component');
      return component;
    };
    const unitTransport = createProjectEditorTransport(transportOptions);
    let unitBase = await readUnitComponent(unitTransport);
    await unitTransport.patchComponent(cid, { params: { voltage_nom: '110' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage_nom: 'кВ' } } }, unitBase.revision);
    unitBase = await readUnitComponent(unitTransport);
    const unitQueue = new ComponentWrites(); unitQueue.seed(sid, unitBase);
    active = 1;
    const peer = createProjectEditorTransport(transportOptions), peerBase = await readUnitComponent(peer);
    expect(peerBase).toEqual(unitBase);
    await peer.patchComponent(cid, { params: { voltage_nom: '110000' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage_nom: 'В' } } }, peerBase.revision);
    const peerGraph = await readProjectScheme(projectId, schemeId, signal);
    active = 0;
    await expect(unitQueue.run(unitBase, () => true,
      revision => unitTransport.patchComponent(cid, { params: { voltage_nom: '220' }, pose: { x: 250 } }, revision),
      { schemeId: sid, intent: [{ kind: 'parameter', key: 'voltage_nom', value: '220' }, { kind: 'pose', values: { x: 250 } }] })).rejects.toMatchObject({ status: 412 });
    expect(parameterRequests[parameterRequests.length - 1]).toMatchObject({ session: 0, status: 412, revision: `"${unitBase.revision}"` });
    expect(await readProjectScheme(projectId, schemeId, signal)).toEqual(peerGraph);
    const unitWorkspace = '55555555-5555-4555-8555-555555555555';
    const unitJournal = captureEditorJournal(unitQueue, schemeId);
    expect(unitJournal.components[0].base).toMatchObject({ params: { voltage_nom: '110' }, declaredParameterUnits: { units: { voltage_nom: 'кВ' } } });
    await saveEditorDraft(scope, unitWorkspace, '0', unitJournal, signal);
    active = 2;
    await expect(readEditorDraft(scope, unitWorkspace, signal)).rejects.toMatchObject({ status: 404 });
    active = 1;
    const storedUnits = await readEditorDraft(scope, unitWorkspace, signal);
    expect(storedUnits.payload).toEqual(unitJournal);
    const unitRestored = restoreProjectEditorJournal(transportOptions, storedUnits.payload);
    let currentUnitServer = await readUnitComponent(unitRestored.transport);
    unitRestored.queue.seed(sid, currentUnitServer);
    let unitReview = unitRestored.queue.drafts.failed(sid)[0];
    expect(compareComponentDraft(unitReview, currentUnitServer).find(row => row.key === 'parameter:voltage_nom')).toMatchObject({ status: 'unit_changed', units: { base: 'кВ', local: 'кВ', server: 'В' } });
    const applyUnits = vi.fn((patch: ComponentPatch, revision: string) => unitRestored.transport.patchComponent(cid, patch, revision));
    const requestCount = parameterRequests.length;
    await expect(unitRestored.queue.recover(unitReview, currentUnitServer, new Set(['parameter:voltage_nom']), () => true, applyUnits)).rejects.toThrow('Единица');
    expect(applyUnits).not.toHaveBeenCalled(); expect(parameterRequests).toHaveLength(requestCount);
    await unitRestored.queue.recover(unitReview, currentUnitServer, new Set(['pose:x']), () => true, applyUnits);
    currentUnitServer = await readUnitComponent(unitRestored.transport);
    expect(currentUnitServer).toMatchObject({ x: 250, params: { voltage_nom: '110000' }, declaredParameterUnits: { units: { voltage_nom: 'В' } } });
    expect(parameterRequests[parameterRequests.length - 1]).toMatchObject({ session: 1, status: 200 });
    unitReview = unitRestored.queue.drafts.failed(sid)[0];
    expect(unitReview.base.declaredParameterUnits?.units.voltage_nom).toBe('кВ');
    await unitRestored.queue.recover(unitReview, currentUnitServer, new Set(['parameter:voltage_nom']), () => true);
    expect(captureEditorJournal(unitRestored.queue, schemeId).components).toEqual([]);
    expect(parameterRequests).toHaveLength(requestCount + 1); // Acceptance sends no parameter PATCH.
    expect(() => unitRestored.queue.assertConfirmed(sid)).not.toThrow();
    await deleteEditorDraft(scope, unitWorkspace, storedUnits.revision, signal);

    // A committed intentional unit change with a lost response is already
    // applied only when both the exact value and the intended unit match.
    loseNextParameter = true;
    await expect(unitRestored.queue.run(currentUnitServer, () => true,
      revision => unitRestored.transport.patchComponent(cid, { params: { voltage_nom: '110' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage_nom: 'кВ' } } }, revision),
      { schemeId: sid, intent: { kind: 'parameter', key: 'voltage_nom', value: '110', unit: 'кВ' } })).rejects.toThrow('value/unit acknowledgement lost');
    const lostUnitJournal = captureEditorJournal(unitRestored.queue, schemeId);
    expect(lostUnitJournal.components[0]).toMatchObject({ base: { params: { voltage_nom: '110000' }, declaredParameterUnits: { units: { voltage_nom: 'В' } } },
      intents: [{ kind: 'parameter', key: 'voltage_nom', value: '110', unit: 'кВ' }] });
    const lostUnitWorkspace = '66666666-6666-4666-8666-666666666666';
    await saveEditorDraft(scope, lostUnitWorkspace, '0', lostUnitJournal, signal);
    active = 0;
    const exactUnitStored = await readEditorDraft(scope, lostUnitWorkspace, signal);
    expect(exactUnitStored.payload).toEqual(lostUnitJournal);
    const exactUnitRestored = restoreProjectEditorJournal(transportOptions, exactUnitStored.payload);
    const exactUnitServer = await readUnitComponent(exactUnitRestored.transport);
    expect(exactUnitServer).toMatchObject({ params: { voltage_nom: '110' }, declaredParameterUnits: { units: { voltage_nom: 'кВ' } } });
    exactUnitRestored.queue.seed(sid, exactUnitServer);
    const exactReview = exactUnitRestored.queue.drafts.failed(sid)[0];
    expect(compareComponentDraft(exactReview, exactUnitServer)[0].status).toBe('already_applied');
    const doNotRepeat = vi.fn((patch: ComponentPatch, revision: string) => exactUnitRestored.transport.patchComponent(cid, patch, revision));
    const committedRequests = parameterRequests.length;
    await exactUnitRestored.queue.recover(exactReview, exactUnitServer, new Set(['parameter:voltage_nom']), () => true, doNotRepeat);
    expect(doNotRepeat).not.toHaveBeenCalled(); expect(parameterRequests).toHaveLength(committedRequests);
    expect(captureEditorJournal(exactUnitRestored.queue, schemeId).components).toEqual([]);
    expect(() => exactUnitRestored.queue.assertConfirmed(sid)).not.toThrow();
    await deleteEditorDraft(scope, lostUnitWorkspace, exactUnitStored.revision, signal);

    // Async-local cookie contexts survive the transport's Promise chain. Both
    // PATCH requests start together with one observed revision and distinct sessions.
    const raceId = Number(created[1].id);
    const beforeRace = await readUnitComponent(exactUnitRestored.transport, raceId);
    await exactUnitRestored.transport.patchComponent(raceId, { params: { voltage_nom: '110' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage_nom: 'кВ' } } }, beforeRace.revision);
    const racerA = createProjectEditorTransport(transportOptions), racerB = createProjectEditorTransport(transportOptions);
    const raceBaseA = await sessions.run(0, () => readUnitComponent(racerA, raceId));
    const raceBaseB = await sessions.run(1, () => readUnitComponent(racerB, raceId));
    expect(raceBaseA).toEqual(raceBaseB);
    const raceStart = parameterRequests.length;
    const raced = await Promise.allSettled([
      sessions.run(0, () => racerA.patchComponent(raceId, { params: { voltage_nom: '110000' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage_nom: 'В' } } }, raceBaseA.revision)),
      sessions.run(1, () => racerB.patchComponent(raceId, { params: { voltage_nom: '220' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage_nom: 'кВ' } } }, raceBaseB.revision)),
    ]);
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = raced.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ status: 412 });
    const raceRequests = parameterRequests.slice(raceStart);
    expect(raceRequests).toHaveLength(2);
    expect(raceRequests.map(request => request.session).sort()).toEqual([0, 1]);
    expect(raceRequests.map(request => request.status).sort()).toEqual([200, 412]);
    expect(raceRequests.every(request => request.revision === `"${raceBaseA.revision}"`)).toBe(true);
    const winner = raceRequests.find(request => request.status === 200)!;
    const winningPair = winner.session === 0 ? { value: '110000', unit: 'В' } : { value: '220', unit: 'кВ' };
    const raceServer = await sessions.run(0, () => readUnitComponent(racerA, raceId));
    expect(raceServer).toMatchObject({ params: { voltage_nom: winningPair.value }, declaredParameterUnits: { units: { voltage_nom: winningPair.unit } } });
    await expect(sessions.run(2, () => racerA.patchComponent(raceId, { params: { voltage_nom: '330' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage_nom: 'кВ' } } }, raceServer.revision))).rejects.toMatchObject({ status: 404 });
    expect(await sessions.run(1, () => readUnitComponent(racerB, raceId))).toEqual(raceServer);
    active = 0;
    await logout(false, signal);
    await expect(listEditorDrafts(scope, signal)).rejects.toMatchObject({ status: 401 });
    active = 1;
    expect(await listEditorDrafts(scope, signal)).toEqual([]);
    expect(paths.filter(path => path.includes('/drafts')).every(path => path.startsWith(`/api/projects/${projectId}/schemes/${schemeId}/drafts`))).toBe(true);
  } finally { sessions.disable(); vi.unstubAllGlobals(); }
}, 45000);
