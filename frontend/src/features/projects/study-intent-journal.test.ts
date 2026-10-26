// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { createStudyIntentJournal, executeStudyIntent, forgetOtherStudySessions, parseStudyIntent, type StudyIntent } from './study-intent-journal';
import { createStudy, appendStudyVersion } from '../../api/studies-api';
vi.mock('../../api/studies-api', async original => ({ ...await original<typeof import('../../api/studies-api')>(), createStudy: vi.fn(), appendStudyVersion: vi.fn() }));
const scope = { accountId: '9007199254740993', sessionId: '9007199254740994', projectId: '8' };
const intent = (): StudyIntent => ({ formatVersion: 1, projectId: '8', schemeId: '7', command: '11111111-1111-4111-8111-111111111111', topology: '9007199254740995', document: { formatVersion: 1, name: 'Намерение', modelGroup: 'three-phase', method: 'newton-raphson', computeBackend: 'julia', maxTimeMs: 20000, base: { s_base_mva: 100, v_base_kv: 10 }, solverOptions: { tolerance: 1e-8, max_iterations: 50 }, operatingLimits: [] } });
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); });
test('reload restores an exact independently parsed command, with no automatic request', () => {
  const a = intent(); createStudyIntentJournal(scope).prepare(a); a.document.name = 'Changed outside';
  const reopened = createStudyIntentJournal(scope); expect(reopened.read()).toEqual(intent());
  const copy = reopened.read()!; copy.document.base.v_base_kv = 500;
  expect(reopened.read()!.document.base.v_base_kv).toBe(10); expect(createStudy).not.toHaveBeenCalled();
});
test('account, session, project and tab stores isolate recovery; unrelated storage survives logout cleanup', () => {
  createStudyIntentJournal(scope).prepare(intent());
  for (const other of [{ ...scope, accountId: '3' }, { ...scope, sessionId: '4' }, { ...scope, projectId: '9' }]) expect(createStudyIntentJournal(other).read()).toBeNull();
  sessionStorage.setItem('unrelated-preference', 'keep');
  forgetOtherStudySessions({ accountId: '3', sessionId: '4' });
  expect(createStudyIntentJournal(scope).read()).toBeNull(); expect(sessionStorage.getItem('unrelated-preference')).toBe('keep');
});
test('a new command, changed body or foreign scope cannot overwrite an unresolved command', () => {
  const journal = createStudyIntentJournal(scope); journal.prepare(intent()); journal.prepare(intent());
  for (const a of [{ ...intent(), command: '22222222-2222-4222-8222-222222222222' }, { ...intent(), document: { ...intent().document, name: 'Replacement' } }]) expect(() => journal.prepare(a)).toThrow();
  expect(() => parseStudyIntent({ ...intent(), projectId: '9' }, '8')).toThrow();
  expect(() => journal.clear('22222222-2222-4222-8222-222222222222')).toThrow(); expect(journal.read()).toEqual(intent());
  journal.clear(intent().command); expect(journal.read()).toBeNull();
});
test('corruption and unavailable persistence block preparation; appended identity pairs are strict', () => {
  const journal = createStudyIntentJournal(scope); journal.prepare(intent()); const key = sessionStorage.key(0)!;
  sessionStorage.setItem(key, '{broken'); expect(() => journal.read()).toThrow(); expect(() => journal.prepare(intent())).toThrow();
  expect(() => createStudyIntentJournal(scope, () => { throw new Error('denied'); }).prepare(intent())).toThrow();
  for (const bad of [{ ...intent(), studyId: '1' }, { ...intent(), expected: '1' }, { ...intent(), credential: 'must not store' }, { ...intent(), schemeId: '../7' }]) expect(() => parseStudyIntent(bad, '8')).toThrow();
});
test('explicit retry retains the original routing, CAS and identity precondition without reading live source', async () => {
  const signal = new AbortController().signal;
  await executeStudyIntent(intent(), scope, signal);
  expect(createStudy).toHaveBeenCalledWith('8', '7', intent().topology, intent().document, intent().command, signal, scope);
  const a = { ...intent(), studyId: '9007199254740996', expected: '9007199254740997' };
  await executeStudyIntent(a, scope, signal);
  expect(appendStudyVersion).toHaveBeenCalledWith('8', a.studyId, a.expected, a.topology, a.document, a.command, signal, scope);
});
