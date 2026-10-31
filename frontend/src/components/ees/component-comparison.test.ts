import { expect, test } from 'vitest';
import type { ComponentDraft } from './component-drafts';
import { compareComponentDraft, prepareRecoveryPatch } from './component-comparison';

const draft: ComponentDraft = { schemeId: 1, componentId: 101, reason: 'conflict', base: {
  id: 101, revision: '1', type: 'busbar', typeId: 1, name: 'Bus', x: 0, y: 0, rotation: 0, params: { voltage: '110', empty: '' },
}, intents: [{ kind: 'pose', values: { x: 10 } }, { kind: 'pose', values: { rotation: 90 } }, { kind: 'parameter', key: 'voltage', value: '220' }] };

test('changed explicit units take priority over identical numbers and block only selected parameter writes', () => {
  const source: ComponentDraft = { ...draft, base: { ...draft.base, declaredParameterUnits: { formatVersion: 1, units: { voltage: 'кВ' } } } };
  const server = { ...source.base, revision: '8', params: { voltage: '220' }, declaredParameterUnits: { formatVersion: 1 as const, units: { voltage: 'В' } } };
  expect(compareComponentDraft(source, server)[2]).toMatchObject({ status: 'unit_changed', units: { base: 'кВ', local: 'кВ', server: 'В' } });
  expect(() => prepareRecoveryPatch(source, server, new Set(['parameter:voltage']))).toThrow('Единица');
  expect(prepareRecoveryPatch(source, server, new Set(['pose:x']))).toEqual({ revision: '8', patch: { pose: { x: 10 } } });
  // No unit is invented for an old journal, even when a current server declares one.
  expect(() => prepareRecoveryPatch(draft, server, new Set(['parameter:voltage']))).toThrow('Единица');
  const without = { ...server, declaredParameterUnits: undefined };
  expect(() => prepareRecoveryPatch(source, without, new Set(['parameter:voltage']))).toThrow('Единица');
  expect(compareComponentDraft(source, source.base)[2].status).toBe('pending');
});

test('intentional value/unit edit is atomic and exact acknowledged pairs need no repeated write', () => {
  const source: ComponentDraft = { ...draft, base: { ...draft.base, declaredParameterUnits: { formatVersion: 1, units: { voltage: 'кВ' } } },
    intents: [{ kind: 'parameter', key: 'voltage', value: '110000', unit: 'В' }] };
  const selected = new Set(['parameter:voltage']);
  expect(prepareRecoveryPatch(source, source.base, selected).patch).toEqual({ params: { voltage: '110000' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage: 'В' } } });
  const applied = { ...source.base, revision: '8', params: { voltage: '110000' }, declaredParameterUnits: { formatVersion: 1 as const, units: { voltage: 'В' } } };
  expect(compareComponentDraft(source, applied)[0].status).toBe('already_applied');
  expect(prepareRecoveryPatch(source, applied, selected).patch).toBeUndefined();
  expect(() => prepareRecoveryPatch(source, { ...applied, params: { voltage: '220000' } }, selected)).toThrow('Единица');
  const repeated: ComponentDraft = { ...source, intents: [...source.intents, { kind: 'parameter', key: 'voltage', value: '220000' }] };
  expect(prepareRecoveryPatch(repeated, source.base, selected).patch).toEqual({ params: { voltage: '220000' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage: 'В' } } });
});

test('recovery refuses a different project passport version even when all object fields match', () => {
  const bound = { ...draft, base: { ...draft.base, projectPassportVersionId: '9007199254740993' } };
  expect(() => prepareRecoveryPatch(bound, { ...bound.base, projectPassportVersionId: '9007199254740994' }, new Set(['pose:x']))).toThrow();
});

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
