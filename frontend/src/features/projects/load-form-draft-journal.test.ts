// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { createLoadFormDraftJournal, forgetOtherLoadFormSessions } from './load-form-draft-journal';
import { loadProfileDraft } from '../../domain/load-profile';
import type { LoadFormDraft } from '../../components/ees/panels/load-form-draft-context';

const scope = { accountId: '1', sessionId: '2', projectId: '3', schemeId: '4' };
const value = (): LoadFormDraft => ({ base: loadProfileDraft({ p: '0.0200' }), draft: loadProfileDraft({ p: '0.03000e-' }), policy: 'saved',
  declaration: { formatVersion: 2, units: { p: 'p.u.' }, bases: { p: { profile: 'ac-three-phase-rms-v1', s_base_mva: 10, v_base_kv: 110 } } } });
const open = (extra = {}) => createLoadFormDraftJournal({ ...scope, ...extra }, new AbortController().signal);
beforeEach(() => sessionStorage.clear());

test('raw incomplete text and original basis survive reopening without shared references', () => {
  const draft = value(); open().save(5, draft); draft.base.p = 'changed'; draft.declaration!.bases!.p!.s_base_mva = 20;
  const restored = open().read(5)!;
  expect(restored).toEqual(value()); restored.draft.p = 'changed';
  expect(open().read(5)).toEqual(value());
});

test('account, session, project, scheme and component are independent scopes', () => {
  open().save(5, value());
  for (const field of ['accountId', 'sessionId', 'projectId', 'schemeId']) expect(open({ [field]: '99' }).read(5)).toBeNull();
  expect(open().read(6)).toBeNull();
  const original = sessionStorage.key(0)!;
  sessionStorage.setItem(original.replace(':4:5', ':4:6'), sessionStorage.getItem(original)!);
  expect(() => open().read(6)).toThrow();
});

test('rejects corrupt, excessive, unrecognized and physically malformed metadata', () => {
  const journal = open(); journal.save(5, value()); const key = sessionStorage.key(0)!;
  for (const broken of ['null', '{}', 'not json', 'x'.repeat(65537)]) {
    sessionStorage.setItem(key, broken); expect(() => journal.read(5)).toThrow();
  }
  expect(() => journal.save(5, { ...value(), acknowledged: true } as LoadFormDraft)).toThrow();
  expect(() => journal.save(5, { ...value(), draft: loadProfileDraft({ p: 'x'.repeat(4097) }) })).toThrow();
  const invalid = value(); invalid.declaration!.bases!.p!.s_base_mva = 0;
  expect(() => journal.save(5, invalid)).toThrow();
});

test('aborted old contexts cannot recreate records after identity cleanup', () => {
  const controller = new AbortController();
  const old = createLoadFormDraftJournal(scope, controller.signal); old.save(5, value());
  forgetOtherLoadFormSessions(null); controller.abort();
  expect(() => old.save(5, value())).toThrow(); expect(() => old.read(5)).toThrow(); expect(sessionStorage.length).toBe(0);
  open().save(5, value()); open({ sessionId: '9' }).save(5, value());
  forgetOtherLoadFormSessions(scope); expect(sessionStorage.length).toBe(1); expect(open().read(5)).toEqual(value());
});

test('detects failed writes and removes only the selected form', () => {
  const failed: Storage = { length: 0, getItem: () => null, setItem: vi.fn(), removeItem: vi.fn(), key: () => null, clear: vi.fn() };
  expect(() => createLoadFormDraftJournal(scope, new AbortController().signal, () => failed).save(5, value())).toThrow();
  open().save(5, value()); open().save(6, value()); open().save(5, null);
  expect(open().read(5)).toBeNull(); expect(open().read(6)).toEqual(value());
});

test('limits retained forms without silently evicting earlier input', () => {
  const journal = open(); for (let i = 1; i <= 128; i++) journal.save(i, value());
  expect(() => journal.save(129, value())).toThrow('128');
  journal.save(1, { ...value(), policy: 'canonical' }); expect(journal.read(128)).toEqual(value());
});
