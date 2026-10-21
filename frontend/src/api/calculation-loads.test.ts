import { expect, test } from 'vitest';
import { parseCalculationLoads, type CalculationLoad } from './calculation-loads';
import { parseCalculationResult } from './ees-api';
import type { CalculationTopology } from './calculation-topology';
const load = (): CalculationLoad => ({ component_id: 5, bus: 2, profile: 'zip', voltage_kv: 9.4, voltage_nom_kv: 10, p_mw: 9.6, q_mvar: 2.8, p_nom_mw: 10, q_nom_mvar: 3 });
const topology: CalculationTopology = { schema_version: 1, node_numbering: 'min-component-terminal', terminals: [{ component_id: 5, component_type: 'load', terminal: 1, bus_id: 2, omitted_reason: null }], internal_nodes: [] };
const context = { nodes: [{ node_id: 2, voltage: 9.4 }], topology, otherIds: [1, 4] };
test('supports archives without load results and verifies current result bindings', () => {
  expect(() => parseCalculationLoads(undefined, context)).not.toThrow();
  expect(() => parseCalculationLoads([load()], context)).not.toThrow();
  expect(() => parseCalculationLoads([{ ...load(), voltage_nom_kv: undefined }], context)).not.toThrow();
  expect(() => parseCalculationLoads([{ ...load(), profile: 'pq', p_nom_mw: 9.6, q_nom_mvar: 2.8, voltage_nom_kv: null }], context)).not.toThrow();
});
test.each([{ component_id: 1 }, { component_id: 6 }, { bus: 9 }, { voltage_kv: Infinity }, { voltage_kv: 9.5 }, { voltage_nom_kv: 0 }, { p_mw: NaN }, { p_nom_mw: '10' }, { profile: 'pq' }, { profile: 'motor' }])('rejects invalid load result %j', patch => {
  expect(() => parseCalculationLoads([{ ...load(), ...patch }], context)).toThrow();
});
test('rejects duplicate ownership, missing loads and an unknown load collection in the common result parser', () => {
  expect(() => parseCalculationLoads([load(), load()], context)).toThrow();
  expect(() => parseCalculationLoads([], context)).toThrow();
  const result = { success: true, node_count: 1, nodes: [{ node_id: 2, node_type: 'pq', voltage: 9.4, angle: 0, phase: 0, quadrature: 0 }], iterations: 1, computation_time_ms: 1, method_used: 'newton-raphson', loads: [load()] };
  expect(parseCalculationResult(result).loads).toEqual([load()]);
  expect(() => parseCalculationResult({ ...result, loads: {} })).toThrow();
});
