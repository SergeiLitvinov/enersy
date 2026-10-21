import { expect, test } from 'vitest';
import { parseCalculationResult, type CalculationSource } from './ees-api';
import type { CalculationBranch } from './calculation-flows';
import { validateSourceTerminalPowers } from './calculation-source-power';

const source = (): CalculationSource => ({ component_id: 7, type: 'slack', internal_bus: 3, terminal_bus: 1,
  p_mw: 10.1, q_mvar: -2.5, terminal_p_mw: 10, terminal_q_mvar: -3, losses_p_mw: 0.1, losses_q_mvar: 0.5, q_limits_applied: false });
const branch = (): CalculationBranch => ({ component_id: 7, code: 'generator', from_bus: 3, to_bus: 1, ratio: 1,
  p_from_mw: 10.1, q_from_mvar: -2.5, p_to_mw: -10, q_to_mvar: 3, losses_p_mw: 0.1, losses_q_mvar: 0.5, i_from_ka: 1, i_to_ka: 1 });

test('signed terminal injection agrees with the impedance flow and internal power balance', () => {
  expect(() => validateSourceTerminalPowers([source()], [branch()])).not.toThrow();
  expect(() => validateSourceTerminalPowers(undefined, undefined)).not.toThrow();
  const legacy = source();
  delete legacy.terminal_p_mw; delete legacy.terminal_q_mvar; delete legacy.losses_p_mw; delete legacy.losses_q_mvar;
  expect(() => validateSourceTerminalPowers([legacy], undefined)).not.toThrow();
  expect(legacy.terminal_p_mw).toBeUndefined();
});

test.each([
  { terminal_p_mw: undefined }, { terminal_q_mvar: NaN }, { losses_p_mw: Infinity },
  { losses_q_mvar: null }, { terminal_p_mw: -10 }, { terminal_q_mvar: 3 },
  { p_mw: 11 }, { q_mvar: 3 }, { losses_p_mw: 0.2 }, { losses_q_mvar: 0.6 },
])('rejects partial, nonfinite or physically inconsistent source powers %j', patch => {
  expect(() => validateSourceTerminalPowers([{ ...source(), ...patch } as CalculationSource], [branch()])).toThrow('на выводах');
});

test('new source data requires its own actual generator branch', () => {
  for (const branches of [undefined, [], [{ ...branch(), component_id: 8 }], [{ ...branch(), code: 'transmission_line' as const }]]) {
    expect(() => validateSourceTerminalPowers([source()], branches)).toThrow();
  }
});

test('the result boundary validates terminal powers after validating flows', () => {
  const result = { success: true, node_count: 2, iterations: 1, computation_time_ms: 1, method_used: 'newton-raphson',
    nodes: [1, 3].map(node_id => ({ node_id, node_type: node_id === 3 ? 'slack' : 'pq', voltage: 10, angle: 0, phase: 10, quadrature: 0 })),
    sources: [source()], branches: [branch()] };
  expect(parseCalculationResult(result)).toBe(result);
  expect(() => parseCalculationResult({ ...result, sources: [{ ...source(), terminal_p_mw: 11 }] })).toThrow('на выводах');
});
