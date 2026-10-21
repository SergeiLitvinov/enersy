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
  for (const raw of [null, [], { ...fixture(), schema_version: 2 }, { ...fixture(), terminals: null }]) {
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
