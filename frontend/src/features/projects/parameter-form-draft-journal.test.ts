// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import { createParameterFormDraftJournal, forgetOtherParameterFormSessions } from './parameter-form-draft-journal';
import { createLoadFormDraftJournal } from './load-form-draft-journal';
import { loadProfileDraft } from '../../domain/load-profile';
import type { ParameterFormDraft } from '../../components/ees/panels/parameter-form-draft-context';
const scope = { accountId: '1', sessionId: '2', projectId: '3', schemeId: '4' };
const value = (): ParameterFormDraft => ({ sourceRevision: '9223372036854775807',
  base: { key: 'p', value: '0.01000', unit: 'p.u.', power: '10', voltage: '110' },
  draft: { key: 'p', value: '0.02000', unit: 'p.u.', power: '20e-', voltage: '' } });
const open = (extra = {}) => createParameterFormDraftJournal({ ...scope, ...extra }, new AbortController().signal);
beforeEach(() => sessionStorage.clear());

test('retains incomplete basis text and exact historical revision without sharing references', () => {
  const draft = value(); open().save(7, draft); draft.base.power = '999';
  expect(open().read(7)).toEqual(value()); const loaded = open().read(7)!; loaded.draft.value = 'other';
  expect(open().read(7)).toEqual(value());
});
test('rejects mixed parameter identities, unknown fields and noncanonical source revision', () => {
  expect(() => open().save(7, { ...value(), draft: { ...value().draft, key: 'q' } })).toThrow();
  expect(() => open().save(7, { ...value(), sourceRevision: '01' })).toThrow();
  expect(() => open().save(7, { ...value(), sourceRevision: '9223372036854775808' })).toThrow();
  expect(() => open().save(7, { ...value(), permission: 'editor' } as ParameterFormDraft)).toThrow();
});
test('is isolated from other identities, components and load forms, including cleanup', () => {
  open().save(7, value()); expect(open({ sessionId: '9' }).read(7)).toBeNull(); expect(open().read(8)).toBeNull();
  createLoadFormDraftJournal(scope, new AbortController().signal).save(7, { base: loadProfileDraft({ p: '1' }), draft: loadProfileDraft({ p: '2' }), declaration: null, policy: 'canonical' });
  forgetOtherParameterFormSessions(null); expect(open().read(7)).toBeNull();
  expect(createLoadFormDraftJournal(scope, new AbortController().signal).read(7)?.draft.p).toBe('2');
});
