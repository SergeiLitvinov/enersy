import type { CalculationTopology } from './calculation-topology';

export interface CalculationBranch {
  component_id: number;
  code: 'generator' | 'transmission_line' | 'transformer';
  from_bus: number; to_bus: number; ratio: number;
  phase_shift_deg?: number;
  p_from_mw: number; q_from_mvar: number; p_to_mw: number; q_to_mvar: number;
  losses_p_mw: number; losses_q_mvar: number; i_from_ka: number; i_to_ka: number;
}
export interface CalculationShunt {
  component_id: number; code: 'capacitor' | 'reactor'; bus: number;
  q_nom_mvar: number; p_mw: number; q_mvar: number;
}
interface FlowContext {
  nodes: readonly { node_id: number; island?: number }[];
  sources?: readonly { component_id: number; internal_bus: number; terminal_bus: number }[];
  topology?: CalculationTopology;
}
const fail = (): never => { throw new Error('Сервис вернул некорректные потоки мощности'); };
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positiveId = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value > 0;
// Endpoint powers include the model's transverse admittances. Their signed sum
// is a branch balance; reactive balance may legitimately be negative.
const balanced = (a: number, b: number, sum: number): boolean =>
  Number.isFinite(a + b) && Math.abs(a + b - sum) <= 1e-7 + 1e-9 * Math.max(Math.abs(a), Math.abs(b), Math.abs(sum));

/** Validate supplied flows against this result's nodes and optional provenance.
 * Older workers may omit either collection; absence never becomes zero flow.
 */
export function parseCalculationFlows(branches: unknown, shunts: unknown, context: FlowContext): void {
  const nodes = new Map(context.nodes.map(node => [node.node_id, node]));
  const sources = new Map(context.sources?.map(source => [source.component_id, source]));
  const terminals = context.topology ? new Map(context.topology.terminals.map(t => [`${t.component_id}:${t.terminal}`, t])) : undefined;
  const owners = new Set<number>();
  const endpoint = (id: number, code: string, ordinal: number, bus: number) => {
    if (!terminals) return;
    const t = terminals.get(`${id}:${ordinal}`);
    if (!t || t.component_type !== code || t.bus_id !== bus) fail();
  };
  if (branches !== undefined) {
    if (!Array.isArray(branches) || branches.length > 1_000_000) return fail();
    for (const value of branches) {
      const b = row(value);
      if (!positiveId(b.component_id) || owners.has(b.component_id) ||
          !['generator', 'transmission_line', 'transformer'].includes(String(b.code)) || typeof b.code !== 'string' ||
          !positiveId(b.from_bus) || !positiveId(b.to_bus) || b.from_bus === b.to_bus ||
          !nodes.has(b.from_bus) || !nodes.has(b.to_bus) || !finite(b.ratio) || b.ratio <= 0 ||
          nodes.get(b.from_bus)?.island !== nodes.get(b.to_bus)?.island) return fail();
      for (const key of ['p_from_mw', 'q_from_mvar', 'p_to_mw', 'q_to_mvar', 'losses_p_mw', 'losses_q_mvar', 'i_from_ka', 'i_to_ka']) {
        if (!finite(b[key])) return fail();
      }
      const branch = b as unknown as CalculationBranch;
      if (b.phase_shift_deg !== undefined && (!finite(b.phase_shift_deg) || Math.abs(b.phase_shift_deg) > 180 ||
          (branch.code !== 'transformer' && b.phase_shift_deg !== 0))) return fail();
      if (branch.i_from_ka < 0 || branch.i_to_ka < 0 ||
          !balanced(branch.p_from_mw, branch.p_to_mw, branch.losses_p_mw) ||
          !balanced(branch.q_from_mvar, branch.q_to_mvar, branch.losses_q_mvar)) return fail();
      if (branch.code === 'generator') {
        const source = sources.get(branch.component_id);
        if (context.sources && (!source || source.internal_bus !== branch.from_bus || source.terminal_bus !== branch.to_bus)) return fail();
        if (terminals && (!source || source.internal_bus !== branch.from_bus)) return fail();
        endpoint(branch.component_id, branch.code, 1, branch.to_bus);
      } else {
        endpoint(branch.component_id, branch.code, 1, branch.from_bus);
        endpoint(branch.component_id, branch.code, 2, branch.to_bus);
      }
      owners.add(branch.component_id);
    }
  }
  if (shunts !== undefined) {
    if (!Array.isArray(shunts) || shunts.length > 1_000_000) return fail();
    for (const value of shunts) {
      const s = row(value);
      if (!positiveId(s.component_id) || owners.has(s.component_id) ||
          (s.code !== 'capacitor' && s.code !== 'reactor') || !positiveId(s.bus) || !nodes.has(s.bus) ||
          !finite(s.q_nom_mvar) || s.q_nom_mvar < 0 || !finite(s.p_mw) || !finite(s.q_mvar)) return fail();
      endpoint(s.component_id, s.code, 1, s.bus);
      owners.add(s.component_id);
    }
  }
}
