import { expect, test } from 'vitest';
import v1JSON from '../../../tests/fixtures/editor-draft-v1.json?raw';
import v2JSON from '../../../tests/fixtures/editor-draft-v2.json?raw';
import unitJSON from '../../../tests/fixtures/editor-draft-units-v2.json?raw';
import { encodeStoredEditorDraftPayload, graphEntriesV2, parseEditorDraftPayloadV2, parseStoredEditorDraftPayload } from './editor-draft-phases';

test('shared value/unit intent fixture retains original and intended units through both journal versions', () => {
  const source = JSON.parse(unitJSON);
  for (const formatVersion of [1, 2]) {
    const payload = { ...source, formatVersion };
    expect(parseStoredEditorDraftPayload(JSON.parse(encodeStoredEditorDraftPayload(payload)))).toEqual(payload);
    for (const unit of [null, undefined, '', ' MW', 'MW\n', '\ud800', 1]) {
      const invalid = JSON.parse(JSON.stringify(payload)); invalid.components[0].intents[0].unit = unit;
      expect(() => parseStoredEditorDraftPayload(invalid)).toThrow();
    }
  }
});

test('both shared wire versions survive independent deep copies; mixed phases never infer CAS', () => {
  const v1 = JSON.parse(v1JSON), v2 = JSON.parse(v2JSON);
  expect(parseStoredEditorDraftPayload(v1)).toEqual(v1);
  const result = parseEditorDraftPayloadV2(v2);
  expect(result).toEqual(v2);
  expect(JSON.parse(encodeStoredEditorDraftPayload(result))).toEqual(v2);
  expect(graphEntriesV2(parseStoredEditorDraftPayload(v1)).every(entry => entry.phase === 'prepared')).toBe(true);
  expect(result.graph[2].intent).not.toHaveProperty('expectedTopologyRevision');
  expect(result.graph[3].intent).toHaveProperty('expectedTopologyRevision', '9007199254740994');
  expect(Object.prototype.hasOwnProperty.call(result.graph[0].intent.kind === 'create-component' ? result.graph[0].intent.params : {}, '__proto__')).toBe(true);
  v2.graph[0].intent.params.p = 'tampered';
  expect(parseEditorDraftPayloadV2(JSON.parse(v2JSON))).toEqual(result);
});
test('phase and CAS rules are strict across field absence, null, aliases and version boundaries', () => {
  const mutations: [string, unknown][] = [
    ['formatVersion', 3], ['graph.0.phase', undefined], ['graph.0.phase', null], ['graph.0.phase', 1],
    ['graph.0.phase', 'dispatched'], ['graph.0.Phase', 'unprepared'],
    ['graph.2.intent.expectedTopologyRevision', null], ['graph.2.intent.expectedTopologyRevision', '0'],
    ['graph.3.intent.expectedTopologyRevision', undefined], ['graph.3.intent.expectedTopologyRevision', null],
    ['graph.3.intent.expectedTopologyRevision', 0], ['graph.3.intent.expectedTopologyRevision', '01'],
    ['graph.3.intent.expectedTopologyRevision', '9223372036854775808'],
    ['graph.4.intent.expectedTopologyRevision', '0'], ['graph.5.intent.expectedTopologyRevision', undefined],
    ['graph.2.intent.fromPort', ''], ['graph.2.intent.from', '2147483648'],
    ['graph.0.intent.rotation', undefined], ['graph.0.intent.params', undefined],
    ['graph.3.intent.commandId', '11111111-1111-4111-8111-111111111111'],
  ];
  for (const [path, value] of mutations) {
    const data: unknown = JSON.parse(v2JSON);
    const parts = path.split('.'); let item = data;
    for (const part of parts.slice(0, -1)) item = (item as Record<string, unknown>)[part];
    (item as Record<string, unknown>)[parts[parts.length - 1]] = value;
    expect(() => parseStoredEditorDraftPayload(data), path).toThrow();
  }
  const v1 = JSON.parse(v1JSON); v1.graph[0].phase = 'prepared';
  expect(() => parseStoredEditorDraftPayload(v1)).toThrow();
  const v2 = JSON.parse(v2JSON); v2.formatVersion = 1;
  expect(() => parseStoredEditorDraftPayload(v2)).toThrow();
});
test('v2 retains component history and limits both phases together without partial exports', () => {
  const data = JSON.parse(v2JSON); data.components = JSON.parse(v1JSON).components;
  expect(parseEditorDraftPayloadV2(data).components[0].base.revision).toBe('9007199254740993');
  data.graph = Array.from({ length: 128 }, (_, i) => ({ phase: i % 2 ? 'prepared' : 'unprepared', reason: '', intent: {
    kind: 'delete-connection', id: String(i + 1), ...(i % 2 ? { expectedTopologyRevision: '0' } : {}),
  } }));
  expect(parseEditorDraftPayloadV2(data).graph).toHaveLength(128);
  data.graph.push({ phase: 'unprepared', reason: '', intent: { kind: 'delete-connection', id: '129' } });
  expect(() => parseEditorDraftPayloadV2(data)).toThrow();
  const large = JSON.parse(v2JSON);
  large.graph[0].intent.params = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), 'x'.repeat(16384)]));
  expect(() => encodeStoredEditorDraftPayload(large)).toThrow('256');
});
