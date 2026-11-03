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
  let active = 0, loseNextPut = false, loseNextConnection = false, loseNextParameter = false, loseNextEquipment = false;
  const paths: string[] = [];
  const connectionRequests: { body: BodyInit | null | undefined; revision: string | null; commandId: string | null }[] = [];
  const equipmentRequests: { body: BodyInit | null | undefined; revision: string | null; commandId: string | null }[] = [];
  const parameterRequests: { session: number; body: BodyInit | null | undefined; revision: string | null; status: number }[] = [];
  vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
    if (!path.startsWith('/api/')) throw new Error('Acceptance request escaped API');
    paths.push(path);
    const jar = sessions.getStore() ?? active;
    const headers = new Headers(options?.headers);
    headers.set('Origin', 'http://localhost:4174');
    if (jars[jar]) headers.set('Cookie', jars[jar]);
    if (path.endsWith('/connection-commands')) connectionRequests.push({ body: options?.body, revision: headers.get('If-Match'), commandId: headers.get('Idempotency-Key') });
    const equipmentCommand = path.endsWith('/components') && options?.method === 'POST' && headers.has('Idempotency-Key');
    if (equipmentCommand) equipmentRequests.push({ body: options?.body, revision: headers.get('If-Match'), commandId: headers.get('Idempotency-Key') });
    const response = await originalFetch(`http://go-api:8080${path}`, { ...options, headers });
    const cookie = response.headers.get('Set-Cookie');
    if (cookie) jars[jar] = cookie.split(';')[0];
    if (loseNextEquipment && equipmentCommand) {
      loseNextEquipment = false;
      expect(response.status).toBe(201);
      await response.body?.cancel();
      throw new TypeError('Acceptance: equipment acknowledgement lost');
    }
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

    // Save the actual creation journal after the API committed, reopen it in a
    // second session and explicitly replay the original value/unit/CAS pair.
    active = 0;
    const createTransport = createProjectEditorTransport(transportOptions), createQueue = new ComponentWrites();
    const creationSchemeId = Number(schemeId);
    const createBefore = await createTransport.getScheme(creationSchemeId);
    const pair = { voltage_nom: '110000.0000' };
    const declaration = { formatVersion: 1 as const, units: { voltage_nom: 'В' } };
    loseNextEquipment = true;
    await expect(createQueue.graph.run(creationSchemeId, { kind: 'create-component', typeId: type.id, name: 'Created with units',
      x: 200, y: 0, rotation: 0, equipmentModelId: null, params: pair, parameterUnitDeclaration: declaration },
    capture => createTransport.createComponent!({ schemeId: creationSchemeId, typeId: type.id, name: 'Created with units',
      x: 200, y: 0, rotation: 0, equipmentModelId: null, params: pair, parameterUnitDeclaration: declaration }, capture)))
      .rejects.toThrow('equipment acknowledgement lost');
    const creationJournal = captureEditorJournal(createQueue, schemeId);
    expect(creationJournal.graph[0].intent).toMatchObject({ params: pair, parameterUnitDeclaration: declaration });
    const creationWorkspace = '88888888-8888-4888-8888-888888888888';
    await saveEditorDraft(scope, creationWorkspace, '0', creationJournal, signal);
    active = 2;
    await expect(readEditorDraft(scope, creationWorkspace, signal)).rejects.toMatchObject({ status: 404 });
    active = 1;
    const creationStored = await readEditorDraft(scope, creationWorkspace, signal);
    expect(creationStored.payload).toEqual(creationJournal);
    const reopenedCreation = restoreProjectEditorJournal(transportOptions, creationStored.payload);
    expect(() => reopenedCreation.queue.assertConfirmed(creationSchemeId)).toThrow();
    const creationReview = await reopenedCreation.queue.graph.review(creationSchemeId, async () => {
      const value = await reopenedCreation.transport.getScheme(creationSchemeId);
      return { id: creationSchemeId, components: value.components!, connections: value.connections! };
    });
    await reopenedCreation.queue.graph.retryCreation(creationReview, creationSchemeId, creationReview.failures[0].id, () => true,
      candidate => {
        if (candidate.kind !== 'create-component') throw new Error('Expected equipment command');
        return reopenedCreation.transport.retryComponentCreation!({ ...candidate, typeId: String(candidate.typeId),
          equipmentModelId: null, params: candidate.params ?? {}, rotation: candidate.rotation ?? 0 });
      },
      async () => {
        const value = await reopenedCreation.transport.getScheme(creationSchemeId);
        expect(value.components).toHaveLength(createBefore.components!.length + 1);
        expect(value.components?.find(item => item.name === 'Created with units')).toMatchObject({ params: pair, declaredParameterUnits: declaration });
      });
    expect(equipmentRequests).toHaveLength(2);
    expect(equipmentRequests[1]).toEqual(equipmentRequests[0]);
    expect(() => reopenedCreation.queue.assertConfirmed(creationSchemeId)).not.toThrow();
    await deleteEditorDraft(scope, creationWorkspace, creationStored.revision, signal);

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
    // Original bases belong to the coefficient representation. A peer can change
    // only S/U, without changing the exact numeric string or the p.u. label.
    active = 0;
    const basis = (power: number, voltage: number) => ({profile:'ac-three-phase-rms-v1' as const,s_base_mva:power,v_base_kv:voltage});
    const basedUnits = (base: ReturnType<typeof basis>) => ({formatVersion:2 as const,units:{voltage_nom:'p.u.'},bases:{voltage_nom:{...base}}});
    const originalBasis = basis(10,10), peerBasis = basis(20,35);
    const basedTransport = createProjectEditorTransport(transportOptions);
    let basedServer = await readUnitComponent(basedTransport);
    await basedTransport.patchComponent(cid,{params:{voltage_nom:'1.0000'},parameterUnitDeclaration:basedUnits(originalBasis)},basedServer.revision);
    const basedBase = await readUnitComponent(basedTransport);
    const basedQueue = new ComponentWrites();basedQueue.seed(sid,basedBase);
    const basisPeer = createProjectEditorTransport(transportOptions);
    const peerBeforeBasis = await sessions.run(1,()=>readUnitComponent(basisPeer));
    await sessions.run(1,()=>basisPeer.patchComponent(cid,{params:{voltage_nom:'1.0000'},parameterUnitDeclaration:basedUnits(peerBasis)},peerBeforeBasis.revision));
    const afterPeerBasis = await readProjectScheme(projectId,schemeId,signal);
    await expect(basedQueue.run(basedBase,()=>true,
      revision=>basedTransport.patchComponent(cid,{params:{voltage_nom:'2.0000'},pose:{y:333}},revision),
      {schemeId:sid,intent:[{kind:'parameter',key:'voltage_nom',value:'2.0000'},{kind:'pose',values:{y:333}}]})).rejects.toMatchObject({status:412});
    expect(await readProjectScheme(projectId,schemeId,signal)).toEqual(afterPeerBasis);
    const basisWorkspace='77777777-7777-4777-8777-777777777777';
    const basisJournal=captureEditorJournal(basedQueue,schemeId);
    expect(basisJournal.components[0].base.declaredParameterUnits?.bases?.voltage_nom).toEqual(originalBasis);
    await saveEditorDraft(scope,basisWorkspace,'0',basisJournal,signal);
    const basisStored=await sessions.run(1,()=>readEditorDraft(scope,basisWorkspace,signal));
    expect(basisStored.payload).toEqual(basisJournal);
    const basisRestored=restoreProjectEditorJournal(transportOptions,basisStored.payload);
    basedServer=await readUnitComponent(basisRestored.transport);basisRestored.queue.seed(sid,basedServer);
    let basisReview=basisRestored.queue.drafts.failed(sid)[0];
    expect(compareComponentDraft(basisReview,basedServer).find(row=>row.key==='parameter:voltage_nom')).toMatchObject({
      status:'unit_changed',units:{base:'p.u.',local:'p.u.',server:'p.u.'},bases:{base:originalBasis,local:originalBasis,server:peerBasis}});
    const basisApply=vi.fn((patch:ComponentPatch,revision:string)=>basisRestored.transport.patchComponent(cid,patch,revision));
    const basisRequestCount=parameterRequests.length;
    await expect(basisRestored.queue.recover(basisReview,basedServer,new Set(['parameter:voltage_nom']),()=>true,basisApply)).rejects.toThrow('базис');
    expect(basisApply).not.toHaveBeenCalled();expect(parameterRequests).toHaveLength(basisRequestCount);
    await basisRestored.queue.recover(basisReview,basedServer,new Set(['pose:y']),()=>true,basisApply);
    basedServer=await readUnitComponent(basisRestored.transport);
    expect(basedServer).toMatchObject({y:333,params:{voltage_nom:'1.0000'},declaredParameterUnits:basedUnits(peerBasis)});
    basisReview=basisRestored.queue.drafts.failed(sid)[0];
    await basisRestored.queue.recover(basisReview,basedServer,new Set(['parameter:voltage_nom']),()=>true);
    expect(parameterRequests).toHaveLength(basisRequestCount+1);
    expect(()=>basisRestored.queue.assertConfirmed(sid)).not.toThrow();
    await deleteEditorDraft(scope,basisWorkspace,basisStored.revision,signal);

    // A basis-only intentional change is already applied after a lost response
    // only if the captured basis, unit AND exact coefficient all agree.
    const intendedBasis=basis(30,110);
    loseNextParameter=true;
    await expect(basisRestored.queue.run(basedServer,()=>true,
      revision=>basisRestored.transport.patchComponent(cid,{params:{voltage_nom:'1.0000'},parameterUnitDeclaration:basedUnits(intendedBasis)},revision),
      {schemeId:sid,intent:{kind:'parameter',key:'voltage_nom',value:'1.0000',unit:'p.u.',base:intendedBasis}})).rejects.toThrow('value/unit acknowledgement lost');
    const basisLostJournal=captureEditorJournal(basisRestored.queue,schemeId);
    expect(basisLostJournal.components[0]).toMatchObject({base:{declaredParameterUnits:basedUnits(peerBasis)},
      intents:[{kind:'parameter',key:'voltage_nom',value:'1.0000',unit:'p.u.',base:intendedBasis}]});
    const basisLostWorkspace='99999999-9999-4999-8999-999999999999';
    await saveEditorDraft(scope,basisLostWorkspace,'0',basisLostJournal,signal);
    const basisLostStored=await sessions.run(1,()=>readEditorDraft(scope,basisLostWorkspace,signal));
    const basisExact=restoreProjectEditorJournal(transportOptions,basisLostStored.payload);
    const exactBasisServer=await readUnitComponent(basisExact.transport);basisExact.queue.seed(sid,exactBasisServer);
    const exactBasisReview=basisExact.queue.drafts.failed(sid)[0];
    expect(compareComponentDraft(exactBasisReview,exactBasisServer)[0].status).toBe('already_applied');
    const doNotRepeatBasis=vi.fn((patch:ComponentPatch,revision:string)=>basisExact.transport.patchComponent(cid,patch,revision));
    const exactBasisRequests=parameterRequests.length;
    await basisExact.queue.recover(exactBasisReview,exactBasisServer,new Set(['parameter:voltage_nom']),()=>true,doNotRepeatBasis);
    expect(doNotRepeatBasis).not.toHaveBeenCalled();expect(parameterRequests).toHaveLength(exactBasisRequests);
    expect(()=>basisExact.queue.assertConfirmed(sid)).not.toThrow();

    // The same persisted historical journal must never infer already_applied
    // from a matching number/unit after another session replaces its basis.
    const laterPeer=await sessions.run(1,()=>readUnitComponent(basisPeer));
    await sessions.run(1,()=>basisPeer.patchComponent(cid,{params:{voltage_nom:'1.0000'},parameterUnitDeclaration:basedUnits(basis(40,220))},laterPeer.revision));
    const divergent=restoreProjectEditorJournal(transportOptions,basisLostStored.payload);
    const divergentServer=await readUnitComponent(divergent.transport);divergent.queue.seed(sid,divergentServer);
    const divergentReview=divergent.queue.drafts.failed(sid)[0];
    expect(compareComponentDraft(divergentReview,divergentServer)[0].status).toBe('unit_changed');
    await expect(divergent.queue.recover(divergentReview,divergentServer,new Set(['parameter:voltage_nom']),()=>true,doNotRepeatBasis)).rejects.toThrow('базис');
    expect(doNotRepeatBasis).not.toHaveBeenCalled();
    await expect(sessions.run(2,()=>readEditorDraft(scope,basisLostWorkspace,signal))).rejects.toMatchObject({status:404});
    await deleteEditorDraft(scope,basisLostWorkspace,basisLostStored.revision,signal);

    // Competing basis-only writes keep the full winning S/U pair atomically.
    const baseRaceA=await sessions.run(0,()=>readUnitComponent(racerA));
    const baseRaceB=await sessions.run(1,()=>readUnitComponent(racerB));
    expect(baseRaceA).toEqual(baseRaceB);
    const basisRaceStart=parameterRequests.length;
    const basisRace=await Promise.allSettled([
      sessions.run(0,()=>racerA.patchComponent(cid,{params:{voltage_nom:'1.0000'},parameterUnitDeclaration:basedUnits(basis(50,330))},baseRaceA.revision)),
      sessions.run(1,()=>racerB.patchComponent(cid,{params:{voltage_nom:'1.0000'},parameterUnitDeclaration:basedUnits(basis(60,400))},baseRaceB.revision)),
    ]);
    expect(basisRace.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);
    expect(basisRace.find(outcome=>outcome.status==='rejected')).toMatchObject({reason:{status:412}});
    const basisRaced=parameterRequests.slice(basisRaceStart);
    expect(basisRaced.map(request=>request.session).sort()).toEqual([0,1]);
    expect(basisRaced.map(request=>request.status).sort()).toEqual([200,412]);
    expect(basisRaced.every(request=>request.revision===`"${baseRaceA.revision}"`)).toBe(true);
    const basisWinner=basisRaced.find(request=>request.status===200)!;
    const winningBasis=basisWinner.session===0?basis(50,330):basis(60,400);
    expect(await readUnitComponent(racerA)).toMatchObject({params:{voltage_nom:'1.0000'},declaredParameterUnits:basedUnits(winningBasis)});
    const beforeForeignBasis=await readProjectScheme(projectId,schemeId,signal);
    const foreignExpected=await readUnitComponent(racerA);
    await expect(sessions.run(2,()=>racerA.patchComponent(cid,{params:{voltage_nom:'1.0000'},parameterUnitDeclaration:basedUnits(basis(70,500))},foreignExpected.revision))).rejects.toMatchObject({status:404});
    expect(await readProjectScheme(projectId,schemeId,signal)).toEqual(beforeForeignBasis);

    // Membership authorization is checked independently from object CAS and
    // personal recovery evidence. The second account uses the real member API.
    let membershipRevision='0';
    const changeMember=async(role:'viewer'|'editor'|'admin'|null)=>sessions.run(0,async()=>{
      const response=await fetch(`/api/projects/${projectId}/members/${other.accountId}`,{
        method:role===null?'DELETE':'PUT',signal,headers:{'Content-Type':'application/json','If-Match':`"${membershipRevision}"`},
        ...(role===null?{}:{body:JSON.stringify({role})})});
      expect(response.status).toBe(200);const body=await response.json();
      expect(BigInt(body.revision)).toBe(BigInt(membershipRevision)+1n);membershipRevision=body.revision;
    });
    const roleWorkspace='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    active=0;await saveEditorDraft(scope,roleWorkspace,'0',basisLostJournal,signal);
    await changeMember('viewer');
    const viewer=createProjectEditorTransport({...transportOptions,writable:false});
    const viewerServer=await sessions.run(2,()=>readUnitComponent(viewer));
    const viewerRequests=parameterRequests.length;
    await expect(sessions.run(2,()=>viewer.patchComponent(cid,{params:{voltage_nom:'3.0000'}},viewerServer.revision))).rejects.toThrow('только для чтения');
    expect(parameterRequests).toHaveLength(viewerRequests);
    await expect(sessions.run(2,()=>readEditorDraft(scope,roleWorkspace,signal))).rejects.toMatchObject({status:404});
    expect(await sessions.run(2,()=>listEditorDrafts(scope,signal))).toEqual([]);
    await expect(sessions.run(2,()=>saveEditorDraft(scope,roleWorkspace,'0',basisLostJournal,signal))).rejects.toMatchObject({status:404});

    await changeMember('editor');
    const memberController=new AbortController(),memberUnavailable=vi.fn(()=>memberController.abort());
    const memberOptions={...transportOptions,signal:memberController.signal,onUnavailable:memberUnavailable};
    const member=createProjectEditorTransport(memberOptions);
    const memberBase=await sessions.run(2,()=>readUnitComponent(member));
    const memberQueue=new ComponentWrites();memberQueue.seed(sid,memberBase);
    // A foreign pose-only update makes the member's numeric write stale while
    // leaving its parameter unit/base usable for a later reviewed PATCH.
    const ownerBeforeRole=await sessions.run(0,()=>readUnitComponent(racerA));
    await sessions.run(0,()=>racerA.patchComponent(cid,{pose:{y:ownerBeforeRole.y+1}},ownerBeforeRole.revision));
    await expect(sessions.run(2,()=>memberQueue.run(memberBase,()=>true,
      revision=>member.patchComponent(cid,{params:{voltage_nom:'2.0000'}},revision),
      {schemeId:sid,intent:{kind:'parameter',key:'voltage_nom',value:'2.0000'}}))).rejects.toMatchObject({status:412});
    const memberPayload=captureEditorJournal(memberQueue,schemeId);
    await sessions.run(2,()=>saveEditorDraft(scope,roleWorkspace,'0',memberPayload,signal));
    expect((await sessions.run(0,()=>readEditorDraft(scope,roleWorkspace,signal))).payload).toEqual(basisLostJournal);
    expect((await sessions.run(2,()=>readEditorDraft(scope,roleWorkspace,signal))).payload).toEqual(memberPayload);
    expect(memberPayload).not.toEqual(basisLostJournal);

    const viewerDeleteWorkspace='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await sessions.run(2,()=>saveEditorDraft(scope,viewerDeleteWorkspace,'0',memberPayload,signal));
    await changeMember('viewer');
    const downgradedServer=await sessions.run(2,()=>readUnitComponent(member));
    const downgradedReview=memberQueue.drafts.failed(sid)[0];
    expect(compareComponentDraft(downgradedReview,downgradedServer)[0].status).toBe('pending');
    const beforeDowngradedWrite=await sessions.run(0,()=>readProjectScheme(projectId,schemeId,signal));
    await expect(sessions.run(2,()=>memberQueue.recover(downgradedReview,downgradedServer,new Set(['parameter:voltage_nom']),()=>true,
      (patch,revision)=>member.patchComponent(cid,patch,revision)))).rejects.toMatchObject({status:404});
    expect(memberUnavailable).toHaveBeenCalledOnce();expect(memberController.signal.aborted).toBe(true);
    expect(await sessions.run(0,()=>readProjectScheme(projectId,schemeId,signal))).toEqual(beforeDowngradedWrite);
    expect((await sessions.run(2,()=>readEditorDraft(scope,roleWorkspace,signal))).payload).toEqual(memberPayload);
    await expect(sessions.run(2,()=>saveEditorDraft(scope,roleWorkspace,'1',memberPayload,signal))).rejects.toMatchObject({status:404});
    await expect(sessions.run(2,()=>deleteEditorDraft(scope,viewerDeleteWorkspace,'1',signal))).resolves.toMatchObject({revision:'2'});
    expect((await sessions.run(2,()=>readEditorDraft(scope,roleWorkspace,signal))).payload).toEqual(memberPayload);

    // Regrant does not revive the aborted editor. A fresh authorized context
    // explicitly restores the same historical document and applies one patch.
    await changeMember('editor');
    const oldContextCount=parameterRequests.length;
    await expect(sessions.run(2,()=>member.patchComponent(cid,{params:{voltage_nom:'9.0000'}},downgradedServer.revision))).rejects.toMatchObject({name:'AbortError'});
    expect(parameterRequests).toHaveLength(oldContextCount);
    const memberRestoreController=new AbortController(),memberRestoreUnavailable=vi.fn(()=>memberRestoreController.abort());
    const memberRestored=restoreProjectEditorJournal({...transportOptions,signal:memberRestoreController.signal,onUnavailable:memberRestoreUnavailable},(await sessions.run(2,()=>readEditorDraft(scope,roleWorkspace,signal))).payload);
    const memberFresh=await sessions.run(2,()=>readUnitComponent(memberRestored.transport));memberRestored.queue.seed(sid,memberFresh);
    const memberReview=memberRestored.queue.drafts.failed(sid)[0];
    const memberPatchCount=parameterRequests.length;
    await sessions.run(2,()=>memberRestored.queue.recover(memberReview,memberFresh,new Set(['parameter:voltage_nom']),()=>true,
      (patch,revision)=>memberRestored.transport.patchComponent(cid,patch,revision)));
    expect(parameterRequests).toHaveLength(memberPatchCount+1);
    expect((await sessions.run(0,()=>readUnitComponent(racerA))).params.voltage_nom).toBe('2.0000');

    await changeMember(null);
    await expect(sessions.run(2,()=>readEditorDraft(scope,roleWorkspace,signal))).rejects.toMatchObject({status:404});
    await expect(sessions.run(2,()=>readProjectScheme(projectId,schemeId,signal))).rejects.toMatchObject({status:404});
    const revokedCount=parameterRequests.length;
    const revokedServer=await sessions.run(0,()=>readUnitComponent(racerA));
    await expect(sessions.run(2,()=>memberRestored.transport.patchComponent(cid,{params:{voltage_nom:'3.0000'}},revokedServer.revision))).rejects.toMatchObject({status:404});
    expect(parameterRequests).toHaveLength(revokedCount+1);
    expect(memberRestoreUnavailable).toHaveBeenCalledOnce();expect(memberRestoreController.signal.aborted).toBe(true);
    expect((await sessions.run(0,()=>readUnitComponent(racerA))).params.voltage_nom).toBe('2.0000');

    // Admin can manage project membership but cannot inspect another account's
    // private journal, even when the same workspace UUID exists for both.
    await changeMember('admin');
    const adminRoster=await sessions.run(2,()=>fetch(`/api/projects/${projectId}/members`,{signal}));expect(adminRoster.status).toBe(200);await adminRoster.body?.cancel();
    expect((await sessions.run(2,()=>readEditorDraft(scope,roleWorkspace,signal))).payload).toEqual(memberPayload);
    expect((await sessions.run(0,()=>readEditorDraft(scope,roleWorkspace,signal))).payload).toEqual(basisLostJournal);
    const ownerOnlyWorkspace='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await sessions.run(0,()=>saveEditorDraft(scope,ownerOnlyWorkspace,'0',basisLostJournal,signal));
    await expect(sessions.run(2,()=>readEditorDraft(scope,ownerOnlyWorkspace,signal))).rejects.toMatchObject({status:404});
    const adminTransport=createProjectEditorTransport(transportOptions);
    const adminBefore=await sessions.run(2,()=>readUnitComponent(adminTransport));
    await sessions.run(2,()=>adminTransport.patchComponent(cid,{params:{voltage_nom:'2.5000'},parameterUnitDeclaration:basedUnits(basis(80,600))},adminBefore.revision));
    expect(await sessions.run(0,()=>readUnitComponent(racerA))).toMatchObject({params:{voltage_nom:'2.5000'},declaredParameterUnits:basedUnits(basis(80,600))});
    await sessions.run(2,()=>deleteEditorDraft(scope,roleWorkspace,'1',signal));
    await sessions.run(0,()=>deleteEditorDraft(scope,roleWorkspace,'1',signal));
    await sessions.run(0,()=>deleteEditorDraft(scope,ownerOnlyWorkspace,'1',signal));
    await changeMember(null);

    active = 0;
    await logout(false, signal);
    await expect(listEditorDrafts(scope, signal)).rejects.toMatchObject({ status: 401 });
    active = 1;
    expect(await listEditorDrafts(scope, signal)).toEqual([]);
    expect(paths.filter(path => path.includes('/drafts')).every(path => path.startsWith(`/api/projects/${projectId}/schemes/${schemeId}/drafts`))).toBe(true);
  } finally { sessions.disable(); vi.unstubAllGlobals(); }
}, 45000);
