import { expect, test, vi } from 'vitest';
import fixtureJSON from '../../../tests/fixtures/editor-draft-v1.json?raw';
import phasesJSON from '../../../tests/fixtures/editor-draft-v2.json?raw';
import { createProject, createProjectScheme, listProjects, login, logout, readProjectScheme } from './projects-api';
import { deleteEditorDraft, listEditorDrafts, readEditorDraft, saveEditorDraft } from './editor-drafts-api';
import { parseEditorDraftPayload } from './editor-draft-payload';
import { parseEditorDraftPayloadV2 } from './editor-draft-phases';
import { createProjectComponent } from './project-scheme-api';
import { getComponentTypes } from './ees-api';
import { ComponentWrites } from '../components/ees/component-writes';
import { captureEditorJournal, restoreProjectEditorJournal } from '../features/projects/editor-journal';
import { createProjectEditorTransport } from '../features/projects/project-editor-transport';

// Enabled only by the disposable Compose service. No configurable production URL.
test.skipIf(import.meta.env.VITE_DRAFT_HTTP_ACCEPTANCE !== '1')('real private draft client survives sessions, CAS conflicts and lost acknowledgement', async () => {
  const originalFetch = globalThis.fetch;
  const jars = ['', '', ''];
  let active = 0, loseNextPut = false, loseNextConnection = false;
  const paths: string[] = [];
  const connectionRequests: { body: BodyInit | null | undefined; revision: string | null; commandId: string | null }[] = [];
  vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
    if (!path.startsWith('/api/')) throw new Error('Acceptance request escaped API');
    paths.push(path);
    const jar = active;
    const headers = new Headers(options?.headers);
    headers.set('Origin', 'http://localhost:4174');
    if (jars[jar]) headers.set('Cookie', jars[jar]);
    if (path.endsWith('/connection-commands')) connectionRequests.push({ body: options?.body, revision: headers.get('If-Match'), commandId: headers.get('Idempotency-Key') });
    const response = await originalFetch(`http://go-api:8080${path}`, { ...options, headers });
    const cookie = response.headers.get('Set-Cookie');
    if (cookie) jars[jar] = cookie.split(';')[0];
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
    active = 0;
    await logout(false, signal);
    await expect(listEditorDrafts(scope, signal)).rejects.toMatchObject({ status: 401 });
    active = 1;
    expect(await listEditorDrafts(scope, signal)).toEqual([]);
    expect(paths.filter(path => path.includes('/drafts')).every(path => path.startsWith(`/api/projects/${projectId}/schemes/${schemeId}/drafts`))).toBe(true);
  } finally { vi.unstubAllGlobals(); }
}, 45000);
