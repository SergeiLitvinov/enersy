import { expect, test } from 'vitest';
import fixtureJSON from '../../../tests/fixtures/editor-draft-v1.json?raw';
import { encodeEditorDraftPayload, parseEditorDraftPayload, type EditorDraftPayload } from './editor-draft-payload';

// Read JSON as data: Vite's JSON-to-object transform changes the __proto__ key.
const fixture: EditorDraftPayload = JSON.parse(fixtureJSON);
const copy = (): EditorDraftPayload => JSON.parse(JSON.stringify(fixture));

test('unit declarations round-trip without inferring legacy labels and reject malformed metadata', () => {
  expect(parseEditorDraftPayload(copy()).components[0].base).not.toHaveProperty('declaredParameterUnits');
  const source = copy();
  source.components[0].base.declaredParameterUnits = { formatVersion: 1, units: { voltage_nom: 'кВ', __proto__: 'unused' } };
  // Only enumerable own keys are data; no inherited unit labels are captured.
  const result = parseEditorDraftPayload(source);
  expect(result.components[0].base.declaredParameterUnits).toEqual({ formatVersion: 1, units: { voltage_nom: 'кВ' } });
  source.components[0].base.declaredParameterUnits.units.voltage_nom = 'В';
  expect(result.components[0].base.declaredParameterUnits?.units.voltage_nom).toBe('кВ');
  expect(parseEditorDraftPayload(JSON.parse(encodeEditorDraftPayload(result)))).toEqual(result);
  for (const raw of [null, undefined, {}, { formatVersion: 2, units: { voltage_nom: 'кВ' } }, { formatVersion: 1, units: {} },
    { formatVersion: 1, units: { absent: 'В' } }, { formatVersion: 1, units: { voltage_nom: ' ' } },
    { formatVersion: 1, units: { voltage_nom: '\ud800' } }, { formatVersion: 1, units: { voltage_nom: 'В' }, extra: true }]) {
    const value = copy(); Object.assign(value.components[0].base, { declaredParameterUnits: raw });
    expect(() => parseEditorDraftPayload(value)).toThrow();
  }
});
test('shared Go/TypeScript wire fixture preserves all intent kinds, historical CAS and independent copies', () => {
  const source = copy(), parsed = parseEditorDraftPayload(source);
  expect(parsed).toEqual(fixture);
  expect(JSON.parse(encodeEditorDraftPayload(source))).toEqual(fixture);
  expect(parsed.components[0].base.revision).toBe('9007199254740993');
  expect(parsed.graph[1].intent).toMatchObject({ commandId: '11111111-1111-4111-8111-111111111111', expectedTopologyRevision: '9007199254740994' });
  expect(Object.prototype.hasOwnProperty.call(parsed.components[0].base.params, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(parsed.components[0].base.params)).toBe(Object.prototype);
  source.components[0].base.params.voltage_nom = 'changed';
  source.components[0].intents.push({ kind: 'delete' });
  expect(parsed.components[0].base.params.voltage_nom).toBe('110');
  expect(parsed.components[0].intents).toHaveLength(3);
});
test('empty journals, empty parameter values, emoji and both integer boundaries remain explicit', () => {
  expect(parseEditorDraftPayload({ formatVersion: 1, components: [], graph: [] })).toEqual({ formatVersion: 1, components: [], graph: [] });
  const source = copy();
  source.components[0].base.rotation = -2147483648;
  source.components[0].base.name = '⚡'.repeat(100);
  source.components[0].base.params.empty = '';
  source.components[0].base.params.literal = '\\ud800';
  source.components[0].base.revision = '9223372036854775807';
  source.components[0].base.typeId = '2147483647';
  expect(parseEditorDraftPayload(source)).toEqual(source);
});
test('damaged recovery data cannot silently drop fields, coerce IDs or invent a topology revision', () => {
  const mutations: [string, unknown][] = [
    ['formatVersion', 2], ['ownerId', '1'], ['components', null],
    ['components.0.componentId', 10], ['components.0.base.id', '11'],
    ['components.0.base.revision', 9007199254740992], ['components.0.base.revision', '9223372036854775808'],
    ['components.0.base.typeId', '2147483648'], ['components.0.base.params', null],
    ['components.0.base.x', Infinity], ['components.0.base.y', 1e50], ['components.0.base.rotation', 0.5],
    ['components.0.base.name', ' '], ['components.0.base.name', '\ud800'], ['components.0.reason', '\udc00'],
    ['components.0.base.params.a\0', 'v'], ['components.0.base.params.p', '\ud800'],
    ['components.0.intents.0.value', null], ['components.0.intents.1.values', {}],
    ['components.0.intents.1.values', { x: null }], ['components.0.intents.2.value', 'hidden'],
    ['components', [fixture.components[0], fixture.components[0]]], ['components.0.intents', []],
    ['graph.1.intent.expectedTopologyRevision', '01'], ['graph.1.intent.expectedTopologyRevision', undefined],
    ['graph.1.intent.commandId', 'ABC'], ['graph.1.intent.from', '2147483648'],
    ['graph.1.intent.fromPort', ''], ['graph', [fixture.graph[1], fixture.graph[1]]],
    ['graph.0.intent.commandId', '11111111-1111-4111-8111-111111111111'],
    ['graph.0.intent.params', undefined], ['graph.2.intent.kind', 'other'], ['components', new Array(1)],
  ];
  for (const [path, value] of mutations) {
    const source = copy();
    const keys = path.split('.');
    let item: unknown = source;
    for (const key of keys.slice(0, -1)) item = (item as Record<string, unknown>)[key];
    (item as Record<string, unknown>)[keys[keys.length - 1]] = value;
    expect(() => parseEditorDraftPayload(source), path).toThrow();
  }
});
test('limits account for UTF-8 bytes and preserve the complete journal instead of truncating it', () => {
  const source = copy();
  source.components[0].base.params.p = 'я'.repeat(8193);
  expect(() => parseEditorDraftPayload(source)).toThrow();
  source.components[0].base.params.p = 'я'.repeat(8192);
  expect(parseEditorDraftPayload(source).components[0].base.params.p).toHaveLength(8192);
  source.components[0].intents = Array.from({ length: 65 }, () => ({ kind: 'delete' }));
  expect(() => parseEditorDraftPayload(source)).toThrow();
  const large = copy();
  large.components[0].base.params = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), 'x'.repeat(16384)]));
  expect(() => encodeEditorDraftPayload(large)).toThrow('256');
  expect(large.components[0].base.params['19']).toHaveLength(16384);
});

test('component, graph and parameter count limits are applied independently of duplicate identity checks', () => {
  const source = copy();
  source.components = Array.from({ length: 128 }, (_, i) => {
    const component = copy().components[0];
    component.componentId = component.base.id = String(i + 1);
    return component;
  });
  expect(parseEditorDraftPayload(source).components).toHaveLength(128);
  source.components.push({ ...copy().components[0], componentId: '129', base: { ...copy().components[0].base, id: '129' } });
  expect(() => parseEditorDraftPayload(source)).toThrow();
  const graph = copy();
  graph.graph = Array.from({ length: 128 }, (_, i) => ({ intent: { kind: 'delete-connection', id: String(i + 1), expectedTopologyRevision: '0' }, reason: '' }));
  expect(parseEditorDraftPayload(graph).graph).toHaveLength(128);
  graph.graph.push({ intent: { kind: 'delete-connection', id: '129', expectedTopologyRevision: '0' }, reason: '' });
  expect(() => parseEditorDraftPayload(graph)).toThrow();
  const parameters = copy();
  parameters.components[0].base.params = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), '']));
  expect(Object.keys(parseEditorDraftPayload(parameters).components[0].base.params)).toHaveLength(256);
  parameters.components[0].base.params.extra = '';
  expect(() => parseEditorDraftPayload(parameters)).toThrow();
});
