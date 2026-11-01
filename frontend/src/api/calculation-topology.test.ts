import { expect, test } from 'vitest';
import { parseCalculationTopology, type CalculationTopology } from './calculation-topology';
import { parseCalculationResult } from './ees-api';

const fixture = (): CalculationTopology => ({ schema_version: 1, node_numbering: 'min-component-terminal',
  terminals: [
    { component_id: 1, component_type: 'generator', terminal: 1, bus_id: 1, omitted_reason: null },
    { component_id: 2, component_type: 'load', terminal: 1, bus_id: 2, omitted_reason: null },
    { component_id: 9, component_type: 'disconnector', terminal: 1, bus_id: null, omitted_reason: 'unused_switch' },
    { component_id: 9, component_type: 'disconnector', terminal: 2, bus_id: null, omitted_reason: 'unused_switch' },
  ], internal_nodes: [{ component_id: 1, bus_id: 3, role: 'source_emf' }] });
const sources = [{ component_id: 1, internal_bus: 3, terminal_bus: 1 }];
const buses = new Set([1, 2, 3]);

test('physical terminals, omitted switches and internal EMF retain distinct identities', () => {
  const value = fixture(); expect(parseCalculationTopology(value, buses, sources)).toBe(value);
});

test.each([
  (v: CalculationTopology) => { v.terminals.push(v.terminals[0]); },
  (v: CalculationTopology) => { v.terminals[1].bus_id = 99; },
  (v: CalculationTopology) => { v.terminals[1].bus_id = 3; },
  (v: CalculationTopology) => { v.terminals[2].component_type = 'load'; },
  (v: CalculationTopology) => { v.internal_nodes[0].component_id = 2; },
  (v: CalculationTopology) => { v.internal_nodes[0].bus_id = 1; },
  (v: CalculationTopology) => { v.terminals[0].terminal = 2; },
])('rejects inconsistent provenance %s', mutate => {
  const value = fixture(); mutate(value);
  expect(() => parseCalculationTopology(value, buses, sources)).toThrow('карту терминалов');
});

test('rejects orphan result nodes, missing sources and malformed versions', () => {
  expect(() => parseCalculationTopology(fixture(), new Set([1, 2, 3, 4]), sources)).toThrow();
  expect(() => parseCalculationTopology(fixture(), buses, [])).toThrow();
  for (const raw of [null, [], { ...fixture(), schema_version: 2 }, { ...fixture(), schema_version: 3 }, { ...fixture(), terminals: null }]) {
    expect(() => parseCalculationTopology(raw, buses, sources)).toThrow();
  }
});

test('result boundary validates provenance while accepting legacy results without it', () => {
  const result = { success: true, node_count: 3, iterations: 1, computation_time_ms: 1, method_used: 'Newton',
    nodes: [1, 2, 3].map(node_id => ({ node_id, node_type: node_id === 3 ? 'slack' : 'pq', voltage: 1, angle: 0, phase: 1, quadrature: 0 })),
    sources: [{ ...sources[0], type: 'slack', p_mw: 10, q_mvar: 3, q_limits_applied: false }] };
  expect(parseCalculationResult(result)).toBe(result);
  expect(parseCalculationResult({ ...result, topology: fixture() }).topology).toEqual(fixture());
  expect(() => parseCalculationResult({ ...result, topology: null })).toThrow();
});

test('v2 binds every branch implementation to physical and internal endpoints', () => {
  const value: CalculationTopology = { ...fixture(), schema_version: 2, branch_origins: [{
    component_id: 1, component_type: 'generator', model_id: 'enersy.ac.source-impedance', role: 'source_impedance',
    from: { kind: 'internal', role: 'source_emf' }, to: { kind: 'terminal', terminal: 1 },
  }] };
  const flows = [{ component_id: 1, code: 'generator', from_bus: 3, to_bus: 1 }];
  expect(parseCalculationTopology(value, buses, sources, flows)).toBe(value);
  for (const mutate of [
    (v: typeof value) => { v.branch_origins = []; },
    (v: typeof value) => { v.branch_origins.push(v.branch_origins[0]); },
    (v: typeof value) => { v.branch_origins[0].component_id = 2; },
    (v: typeof value) => { v.branch_origins[0].model_id = 'enersy.ac.line-pi'; },
    (v: typeof value) => { v.branch_origins[0].role = 'line_pi'; },
    (v: typeof value) => { v.branch_origins[0].from = { kind: 'terminal', terminal: 1 }; },
    (v: typeof value) => { v.branch_origins[0].to = { kind: 'terminal', terminal: 2 }; },
  ]) {
    const broken = structuredClone(value); mutate(broken);
    expect(() => parseCalculationTopology(broken, buses, sources, flows)).toThrow();
  }
  expect(() => parseCalculationTopology(value, buses, sources)).toThrow();
  expect(() => parseCalculationTopology({ ...value, branch_origins: [] }, buses, sources, [])).toThrow();
  expect(() => parseCalculationTopology(value, buses, sources, [...flows, ...flows])).toThrow();
  expect(() => parseCalculationTopology(value, buses, sources, [{ ...flows[0], from_bus: 1, to_bus: 3 }])).toThrow();
  expect(() => parseCalculationTopology({ ...value, schema_version: 1 }, buses, sources, flows)).toThrow();
});

test.each(['transmission_line', 'transformer'] as const)('v2 %s retains terminal orientation', code => {
  const model = code === 'transformer' ? 'enersy.ac.transformer-2w' : 'enersy.ac.line-pi';
  const role = code === 'transformer' ? 'transformer_2w' : 'line_pi';
  const value: CalculationTopology = { schema_version: 2, node_numbering: 'min-component-terminal',
    terminals: [1, 2].map(terminal => ({ component_id: 8, component_type: code, terminal, bus_id: terminal, omitted_reason: null })),
    internal_nodes: [], branch_origins: [{ component_id: 8, component_type: code, model_id: model, role,
      from: { kind: 'terminal', terminal: 1 }, to: { kind: 'terminal', terminal: 2 } }] };
  const branches = [{ component_id: 8, code, from_bus: 1, to_bus: 2 }];
  expect(parseCalculationTopology(value, new Set([1, 2]), [], branches)).toBe(value);
  expect(() => parseCalculationTopology(value, new Set([1, 2]), [], [{ ...branches[0], from_bus: 2, to_bus: 1 }])).toThrow();
});
