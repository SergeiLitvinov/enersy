import { afterEach, expect, test, vi } from 'vitest';
import { getModelDefinitions, parseModelDefinitions } from './model-definitions';
export function definitionFixture() {
  return { schema_version: 1, kernel_version: '0.1.0', source_revision: 'a'.repeat(64), source_files: [{ path: 'backend-julia/src/models.jl', sha256: 'b'.repeat(64) }], model_group: 'three-phase', method: 'newton-raphson', status: 'experimental', definitions: [{ id: 'test.model', equipment_type: 'generator', name: 'Test source', implementation: 'models.jl: generator_model', equations: ['E = V + ZI'], limitations: ['Test symbolic structure only'], nodes: [{ id: 'external', label: 'External', x: 60, y: 60, terminal: 1 }, { id: 'internal', label: 'Internal', x: 240, y: 60, terminal: 0 }], edges: [{ id: 'z', from: 'external', to: 'internal', kind: 'impedance', label: 'Z' }] }] };
}
afterEach(() => vi.unstubAllGlobals());

test('passive symbols are explicit safe metadata, independent of equipment UGO', () => {
  for (const symbol of ['inductor', 'capacitor'] as const) {
    const data = definitionFixture();
    Object.assign(data.definitions[0].edges[0], { symbol });
    expect(parseModelDefinitions(data).definitions[0].edges[0].symbol).toBe(symbol);
  }
  for (const symbol of ['<svg onload=alert(1)>', ['inductor'], null, 1]) {
    const data = definitionFixture(); Object.assign(data.definitions[0].edges[0], { symbol });
    expect(() => parseModelDefinitions(data)).toThrow();
  }
  const source = definitionFixture(); Object.assign(source.definitions[0].edges[0], { symbol: 'inductor', kind: 'source' });
  expect(() => parseModelDefinitions(source)).toThrow();
  const coincident = definitionFixture(); Object.assign(coincident.definitions[0].edges[0], { symbol: 'inductor' });
  coincident.definitions[0].nodes[1].x = coincident.definitions[0].nodes[0].x;
  expect(() => parseModelDefinitions(coincident)).toThrow();
});
test('parses a versioned symbolic model and rejects dangling, duplicated, unsafe or unknown descriptions', () => {
  const fixture = definitionFixture(); expect(parseModelDefinitions(fixture).definitions[0].nodes).toHaveLength(2);
  const invalid = [
    (data: ReturnType<typeof definitionFixture>) => { data.definitions[0].edges[0].to = 'missing'; },
    (data: ReturnType<typeof definitionFixture>) => { data.definitions[0].nodes.push(data.definitions[0].nodes[0]); },
    (data: ReturnType<typeof definitionFixture>) => { data.definitions[0].nodes[0].x = Infinity; },
    (data: ReturnType<typeof definitionFixture>) => { data.schema_version = 4; },
    (data: ReturnType<typeof definitionFixture>) => { data.status = 'ready'; },
    (data: ReturnType<typeof definitionFixture>) => { data.source_files[0].path = 'backend-julia/src/../private.jl'; },
    (data: ReturnType<typeof definitionFixture>) => { data.source_revision = 'unknown'; },
  ];
  for (const mutate of invalid) { const value = definitionFixture(); mutate(value); expect(() => parseModelDefinitions(value)).toThrow(); }
});

test('v3 adds an ideal transformer with required metadata, retaining previous contracts', () => {
  const transformer = () => {
    const raw = definitionFixture();
    raw.definitions[0].edges[0].kind = 'transformer';
    return { ...raw, schema_version: 3, definitions: raw.definitions.map(d => ({ ...d, parameters: [] })) };
  };
  expect(parseModelDefinitions(transformer()).definitions[0].edges[0].kind).toBe('transformer');
  for (const version of [1, 2]) expect(() => parseModelDefinitions({ ...transformer(), schema_version: version })).toThrow();
  expect(() => parseModelDefinitions({ ...definitionFixture(), schema_version: 3 })).toThrow();
  const symbol = transformer(); Object.assign(symbol.definitions[0].edges[0], { symbol: 'inductor' });
  expect(() => parseModelDefinitions(symbol)).toThrow();
  const coincident = transformer(); coincident.definitions[0].nodes[1].x = coincident.definitions[0].nodes[0].x;
  expect(() => parseModelDefinitions(coincident)).toThrow();
  expect(parseModelDefinitions(definitionFixture()).schema_version).toBe(1);
});
test('does not fetch for an already cancelled request and rejects failed metadata responses', async () => {
  const fetcher = vi.fn(async () => new Response('{}', { status: 503 })); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(); controller.abort(); await expect(getModelDefinitions(controller.signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  await expect(getModelDefinitions()).rejects.toThrow('недоступны');
});

test('v2 requires parameter metadata, rejects duplicate or malformed keys and retains v1 without invented defaults', () => {
  const param = { key: 'x', name: 'Reactance', unit: 'Ohm', kind: 'number', requirement: 'required', default_value: null, note: 'Per phase' };
  const fixture = () => { const raw = definitionFixture(); return { ...raw, schema_version: 2, definitions: raw.definitions.map(item => ({ ...item, parameters: [param] })) }; };
  expect(parseModelDefinitions(fixture()).definitions[0].parameters).toEqual([param]);
  expect(parseModelDefinitions(definitionFixture()).definitions[0].parameters).toBeUndefined();
  expect(() => parseModelDefinitions({ ...definitionFixture(), schema_version: 2 })).toThrow();
  const duplicated = fixture(); duplicated.definitions[0].parameters.push(param);expect(() => parseModelDefinitions(duplicated)).toThrow();
  for (const malformed of [{ ...param, key: '../x' }, { ...param, default_value: 0 }, { ...param, requirement: 'maybe' }, { ...param, kind: 'script' }]) {
    const value = fixture(); value.definitions[0].parameters = [malformed as typeof param];expect(() => parseModelDefinitions(value)).toThrow();
  }
});
