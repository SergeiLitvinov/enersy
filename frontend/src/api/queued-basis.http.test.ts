import { expect, test, vi } from 'vitest';
import { login, logout, readProject } from './projects-api';
import { createProjectEditorTransport } from '../features/projects/project-editor-transport';
import { ComponentWrites } from '../components/ees/component-writes';
import { compareComponentDraft } from '../components/ees/component-comparison';
import { captureEditorJournal, restoreProjectEditorJournal } from '../features/projects/editor-journal';
import type { SchemeComponent } from './ees-api';
import { sameParameterBase } from '../domain/parameter-base';

function requiredFixtureBase(source: SchemeComponent) {
  const basis = source.declaredParameterUnits?.bases?.p;
  if (!basis) throw new Error('Original fixture basis absent');
  return basis;
}

/** Existing operator-created synthetic fixture only. No account/member changes. */
test.skipIf(import.meta.env.VITE_QUEUED_BASIS_HTTP !== '1')('queued coefficient keeps its historical basis across a real acknowledged PATCH', async () => {
  const { readQueuedBasisFixture } = await import('../test/queued-basis-fixture.mjs');
  const credentials = await readQueuedBasisFixture();
  const originalFetch = globalThis.fetch;
  let cookie = '', patches = 0, source: SchemeComponent | undefined;
  let releaseAcknowledgement: (() => void) | undefined, settled: Promise<unknown> | undefined;
  const signal = AbortSignal.timeout(30000);
  const options = { projectId: '1', schemeId: '1', name: 'Нагрузка · проверка ролей', writable: true, signal };
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (!/^\/api\/(?:auth\/(?:login|logout)|projects\/1(?:\/schemes\/1(?:\/components\/1)?)?)$/.test(path)) throw new Error('Request escaped the disposable fixture');
    const headers = new Headers(init?.headers); headers.set('Origin', 'http://localhost:4177');
    if (cookie) headers.set('Cookie', cookie);
    if (init?.method === 'PATCH') patches++;
    const response = await originalFetch(`http://go-api:8080${path}`, { ...init, headers });
    const updated = response.headers.get('Set-Cookie'); if (updated) cookie = updated.split(';')[0];
    return response;
  });
  const transport = createProjectEditorTransport(options);
  const read = async (reader = transport) => {
    const graph = await reader.getScheme(1); expect(graph.name).toBe(options.name);
    const load = graph.components?.find(item => item.id === 1);
    expect(load).toMatchObject({ type: 'load', name: 'Нагрузка роли' });
    if (!load) throw new Error('Fixture load absent');
    return load;
  };
  try {
    const identity = await login(credentials.login, credentials.password, signal);
    expect((await readProject('1', signal)).name).toBe('Роли · восстановление');
    source = await read();
    expect(source.declaredParameterUnits?.units.p).toBe('p.u.');
    const original = source.declaredParameterUnits?.bases?.p;
    if (!original || original.s_base_mva > 1000 || original.v_base_kv > 1000) throw new Error('Unexpected fixture source basis');
    const changed = { ...original, s_base_mva: original.s_base_mva + 10 };
    const queue = new ComponentWrites(); queue.seed(1, source);
    const acknowledgement = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
    let committed!: () => void, failed!: (error: unknown) => void;
    const commit = new Promise<void>((resolve, reject) => { committed = resolve; failed = reject; });
    const first = queue.run(source, () => true, async revision => {
      try {
        const result = await transport.patchComponent(1, { params: { p: source!.params.p }, parameterUnitDeclaration: { formatVersion: 2, units: { p: 'p.u.' }, bases: { p: changed } } }, revision);
        committed(); await acknowledgement; return result;
      } catch (error) { failed(error); throw error; }
    }, { schemeId: 1, intent: { kind: 'parameter', key: 'p', value: source.params.p, unit: 'p.u.', base: changed } });
    // The real server commit finishes while its client acknowledgement is held.
    const second = queue.run(source, () => true, revision => transport.patchComponent(1, { params: { p: '0.030000' }, parameterUnitDeclaration: { formatVersion: 1, units: { p: 'p.u.' } } }, revision),
      { schemeId: 1, intent: { kind: 'parameter', key: 'p', value: '0.030000', unit: 'p.u.' } });
    const outcome = second.then(() => null, error => error);
    settled = Promise.allSettled([first, second]);
    await commit;
    const whilePending = await read(); expect(whilePending.declaredParameterUnits?.bases?.p).toEqual(changed); expect(patches).toBe(1);
    releaseAcknowledgement!(); await first; expect(await outcome).toBeInstanceOf(Error); expect(patches).toBe(1);
    const server = await read(); expect(server.params).toEqual(source.params); expect(server.declaredParameterUnits?.bases?.p).toEqual(changed);
    const saved = JSON.parse(JSON.stringify(captureEditorJournal(queue, '1')));
    expect(saved.components[0].base.declaredParameterUnits.bases.p).toEqual(original);
    const restored = restoreProjectEditorJournal({ ...options, identity }, saved); restored.queue.seed(1, server);
    const draft = restored.queue.drafts.failed(1)[0]; expect(compareComponentDraft(draft, server)[0].status).toBe('unit_changed');
    await expect(restored.queue.recover(draft, server, new Set(['parameter:p']), () => true, (patch, revision) => restored.transport.patchComponent(1, patch, revision))).rejects.toThrow('Единица');
    expect(patches).toBe(1);
    await restored.queue.recover(restored.queue.drafts.failed(1)[0], server, new Set(['parameter:p']), () => true);
    expect(restored.queue.drafts.hasFailed(1)).toBe(false); expect(patches).toBe(1);
    // Also reject a callback registered only after the first acknowledgement,
    // if it still holds the old observed component representation.
    await expect(restored.queue.run(source, () => true,
      revision => restored.transport.patchComponent(1, { params: { p: '0.030000' } }, revision),
      { schemeId: 1, intent: { kind: 'parameter', key: 'p', value: '0.030000' } })).rejects.toThrow('не подтверждено');
    expect(patches).toBe(1);
    expect(captureEditorJournal(restored.queue, '1').components[0].base.declaredParameterUnits?.bases?.p).toEqual(original);
    await restored.queue.recover(restored.queue.drafts.failed(1)[0], server, new Set(['parameter:p']), () => true);
  } finally {
    try {
      releaseAcknowledgement?.(); await settled;
      if (source) {
        const cleanup = createProjectEditorTransport({ ...options, signal: AbortSignal.timeout(15000) });
        const current = await read(cleanup), original = requiredFixtureBase(source);
        const currentBasis = current.declaredParameterUnits?.bases?.p;
        if (!sameParameterBase(currentBasis, original)) {
          expect(currentBasis).toEqual({ ...original, s_base_mva: original.s_base_mva + 10 });
          expect([source.params.p, '0.030000']).toContain(current.params.p);
          await cleanup.patchComponent(1, { params: { p: source.params.p }, parameterUnitDeclaration: { formatVersion: 2, units: { p: 'p.u.' }, bases: { p: original } } }, current.revision!);
        }
        const after = await read(cleanup); expect(after.params).toEqual(source.params); expect(after.declaredParameterUnits).toEqual(source.declaredParameterUnits);
      }
    } finally { try { if (cookie) await logout(false, AbortSignal.timeout(10000)); } finally { vi.unstubAllGlobals(); } }
  }
}, 60000);
