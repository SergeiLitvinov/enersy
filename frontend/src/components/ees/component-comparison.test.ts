import { expect, test } from 'vitest';
import type { ComponentDraft } from './component-drafts';
import { compareComponentDraft, prepareRecoveryPatch } from './component-comparison';

const draft: ComponentDraft = { schemeId: 1, componentId: 101, reason: 'conflict', base: {
  id: 101, revision: '1', type: 'busbar', typeId: 1, name: 'Bus', x: 0, y: 0, rotation: 0, params: { voltage: '110', empty: '' },
}, intents: [{ kind: 'pose', values: { x: 10 } }, { kind: 'pose', values: { rotation: 90 } }, { kind: 'parameter', key: 'voltage', value: '220' }] };

test('comparison separates pending, externally changed and already applied fields', () => {
  const rows = compareComponentDraft(draft, { ...draft.base, revision: '8', rotation: 90, y: 200, params: { voltage: '330' } });
  expect(rows.map(row => [row.key, row.status])).toEqual([
    ['pose:x', 'pending'], ['pose:rotation', 'already_applied'], ['parameter:voltage', 'server_changed'],
  ]);
  expect(rows[2]).toMatchObject({ base: '110', local: '220', server: '330' });
  expect(rows.some(row => row.key === 'pose:y')).toBe(false);
});

test('last local intent wins comparison without modifying any input', () => {
  const repeated = { ...draft, intents: [...draft.intents, { kind: 'pose' as const, values: { x: 20 } }] };
  const before = JSON.stringify(repeated);
  expect(compareComponentDraft(repeated, draft.base)[0].local).toBe(20);
  expect(JSON.stringify(repeated)).toBe(before);
});

test('missing object, deletion and empty versus absent parameter are explicit', () => {
  expect(compareComponentDraft(draft).every(row => row.status === 'object_missing')).toBe(true);
  expect(compareComponentDraft({ ...draft, intents: [{ kind: 'delete' }] })[0]).toMatchObject({ server: false, status: 'already_applied' });
  const empty = { ...draft, intents: [{ kind: 'parameter' as const, key: 'empty', value: '' }] };
  expect(compareComponentDraft(empty, { ...draft.base, params: {} })[0]).toMatchObject({ base: '', local: '', server: undefined, status: 'server_changed' });
});

test('prototype names never masquerade as existing parameter values', () => {
  const rows = compareComponentDraft({ ...draft, intents: [{ kind: 'parameter', key: 'toString', value: 'test' }] }, draft.base);
  expect(rows[0]).toMatchObject({ base: undefined, server: undefined, local: 'test', status: 'pending' });
});

test('reviewed write contains selected final values and preserves the compared version', () => {
  const server = { ...draft.base, revision: '9007199254740993', y: 200, name: 'Peer name', params: { voltage: '330' } };
  expect(prepareRecoveryPatch(draft, server, new Set(['pose:x', 'parameter:voltage']))).toEqual({
    revision: '9007199254740993', patch: { pose: { x: 10 }, params: { voltage: '220' } },
  });
  expect(prepareRecoveryPatch(draft, server, new Set(['pose:rotation']))).toEqual({ revision: '9007199254740993', patch: { pose: { rotation: 90 } } });
});

test('already matching values need no write; deletion and missing or replaced objects are rejected', () => {
  expect(prepareRecoveryPatch(draft, { ...draft.base, x: 10 }, new Set(['pose:x']))).toEqual({ revision: '1', patch: undefined });
  for (const server of [undefined, { ...draft.base, id: 102 }, { ...draft.base, typeId: 2 }, { ...draft.base, equipmentModelId: 8 }]) {
    expect(() => prepareRecoveryPatch(draft, server, new Set(['pose:x']))).toThrow('Объект');
  }
  expect(() => prepareRecoveryPatch(draft, draft.base, new Set())).toThrow('Выберите');
  expect(() => prepareRecoveryPatch({ ...draft, intents: [{ kind: 'delete' }] }, draft.base, new Set(['delete']))).toThrow('отдельно');
  expect(() => prepareRecoveryPatch(draft, draft.base, new Set(['pose:y']))).toThrow();
});
