import { expect, test } from 'vitest';
import { parseCalculationFlows, type CalculationBranch, type CalculationShunt } from './calculation-flows';
import { parseCalculationResult } from './ees-api';
import type { CalculationTopology } from './calculation-topology';

const line = (): CalculationBranch => ({ component_id: 4, code: 'transmission_line', from_bus: 1, to_bus: 2, ratio: 1,
  p_from_mw: 10.1, p_to_mw: -10, q_from_mvar: -1, q_to_mvar: -2, losses_p_mw: 0.1, losses_q_mvar: -3, i_from_ka: 0.6, i_to_ka: 0.6 });
const capacitor = (): CalculationShunt => ({ component_id: 5, code: 'capacitor', bus: 2, q_nom_mvar: 2, p_mw: 0, q_mvar: -1.9 });
const topology: CalculationTopology = { schema_version: 1, node_numbering: 'min-component-terminal', terminals: [
  { component_id: 4, component_type: 'transmission_line', terminal: 1, bus_id: 1, omitted_reason: null },
  { component_id: 4, component_type: 'transmission_line', terminal: 2, bus_id: 2, omitted_reason: null },
  { component_id: 5, component_type: 'capacitor', terminal: 1, bus_id: 2, omitted_reason: null },
], internal_nodes: [] };
const context = { nodes: [{ node_id: 1, island: 1 }, { node_id: 2, island: 1 }], topology };

test('accepts signed endpoint powers, capacitive reactive balance and snapshot bindings', () => {
  expect(() => parseCalculationFlows([line()], [capacitor()], context)).not.toThrow();
  expect(() => parseCalculationFlows(undefined, undefined, context)).not.toThrow();
});

test('phase shift is finite bounded transformer metadata; old archives retain absence', () => {
  const transformer = { ...line(), code: 'transformer' };
  const ctx = { nodes: context.nodes };
  for (const phase_shift_deg of [-180, -30, 0, 30, 180]) {
    expect(() => parseCalculationFlows([{ ...transformer, phase_shift_deg }], [], ctx)).not.toThrow();
  }
  for (const phase_shift_deg of [181, -181, NaN, Infinity, '30', null]) {
    expect(() => parseCalculationFlows([{ ...transformer, phase_shift_deg }], [], ctx)).toThrow();
  }
  expect(() => parseCalculationFlows([{ ...line(), phase_shift_deg: 30 }], [], ctx)).toThrow();
  expect(() => parseCalculationFlows([transformer], [], ctx)).not.toThrow();
});
test.each([
  { from_bus: 2, to_bus: 1 }, { to_bus: 99 }, { to_bus: 1 }, { code: 'capacitor' },
  { component_id: 8 }, { i_from_ka: -0.01 }, { ratio: 0 }, { p_from_mw: Infinity },
  { losses_p_mw: 1 }, { losses_q_mvar: 3 }, { component_id: 1.5 }, { code: ['transmission_line'] },
])('rejects invalid branch or terminal provenance %j', patch => {
  expect(() => parseCalculationFlows([{ ...line(), ...patch }], [], context)).toThrow('потоки мощности');
});
test('rejects cross-island branches and duplicate or conflicting ownership', () => {
  expect(() => parseCalculationFlows([line()], [], { nodes: [{ node_id: 1, island: 1 }, { node_id: 2, island: 2 }] })).toThrow();
  expect(() => parseCalculationFlows([line(), line()], [], context)).toThrow();
  expect(() => parseCalculationFlows([line()], [{ ...capacitor(), component_id: 4 }], context)).toThrow();
});
test.each([{ bus: 1 }, { q_nom_mvar: -1 }, { q_mvar: NaN }, { code: 'load' }, { component_id: 1 }, { bus: null }])('rejects invalid shunt %j', patch => {
  expect(() => parseCalculationFlows([], [{ ...capacitor(), ...patch }], context)).toThrow();
});
test('source impedance runs from internal EMF to external T1, never the reverse', () => {
  const branch = { ...line(), code: 'generator', component_id: 7, from_bus: 3, to_bus: 1 };
  const sourceContext = { nodes: [{ node_id: 1 }, { node_id: 3 }], sources: [{ component_id: 7, internal_bus: 3, terminal_bus: 1 }],
    topology: { ...topology, terminals: [{ component_id: 7, component_type: 'generator', terminal: 1, bus_id: 1, omitted_reason: null }], internal_nodes: [{ component_id: 7, bus_id: 3, role: 'source_emf' }] } as CalculationTopology };
  expect(() => parseCalculationFlows([branch], [], sourceContext)).not.toThrow();
  expect(() => parseCalculationFlows([{ ...branch, from_bus: 1, to_bus: 3 }], [], sourceContext)).toThrow();
  expect(() => parseCalculationFlows([branch], [], { ...sourceContext, sources: [] })).toThrow();
});
test('rejects malformed collections and overflow instead of accepting non-finite balance', () => {
  for (const value of [null, {}, [null], [[]]]) expect(() => parseCalculationFlows(value, [], context)).toThrow();
  expect(() => parseCalculationFlows([{ ...line(), p_from_mw: 1e308, p_to_mw: 1e308, losses_p_mw: 1e308 }], [], context)).toThrow();
});
test('the result boundary validates optional flow fields and retains legacy absence', () => {
  const value = { success: true, nodes: [1, 2].map(node_id => ({ node_id, node_type: 'pq', voltage: 10, angle: 0, phase: 10, quadrature: 0 })),
    node_count: 2, iterations: 1, computation_time_ms: 1, method_used: 'newton-raphson' };
  expect(parseCalculationResult(value).branches).toBeUndefined();
  expect(parseCalculationResult({ ...value, branches: [line()], shunts: [capacitor()] }).branches).toEqual([line()]);
  expect(() => parseCalculationResult({ ...value, branches: [{ ...line(), losses_p_mw: 5 }] })).toThrow();
});
