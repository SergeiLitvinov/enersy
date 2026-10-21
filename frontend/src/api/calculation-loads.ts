import type { CalculationTopology } from './calculation-topology';

export interface CalculationLoad {
  component_id: number; bus: number; profile: 'pq' | 'zip';
  voltage_kv: number; voltage_nom_kv?: number | null;
  p_mw: number; q_mvar: number; p_nom_mw: number; q_nom_mvar: number;
}

const fail = (): never => { throw new Error('Сервис вернул некорректные результаты нагрузок'); };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const id = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value > 0;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/** Optional for older archives. Supplied values must agree with node/terminal IDs. */
export function parseCalculationLoads(raw: unknown, context: {
  nodes: readonly { node_id: number; voltage: number }[];
  topology?: CalculationTopology; otherIds: Iterable<number>;
}): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > 1_000_000) return fail();
  const nodes = new Map(context.nodes.map(n => [n.node_id, n.voltage]));
  const owners = new Set(context.otherIds), seen = new Set<number>();
  const terminals = context.topology ? new Map(context.topology.terminals.filter(t => t.component_type === 'load' && t.terminal === 1).map(t => [t.component_id, t.bus_id])) : undefined;
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const row = value as Record<string, unknown>;
    if (!id(row.component_id) || owners.has(row.component_id) || seen.has(row.component_id) || !id(row.bus) || !nodes.has(row.bus) ||
        (row.profile !== 'pq' && row.profile !== 'zip') ||
        !finite(row.voltage_kv) || row.voltage_kv <= 0 || !close(row.voltage_kv, nodes.get(row.bus)!) ||
        ![row.p_mw, row.q_mvar, row.p_nom_mw, row.q_nom_mvar].every(finite)) return fail();
    if (row.voltage_nom_kv !== undefined && row.voltage_nom_kv !== null && (!finite(row.voltage_nom_kv) || row.voltage_nom_kv <= 0)) return fail();
    if (row.profile === 'pq' && (!close(row.p_mw as number, row.p_nom_mw as number) || !close(row.q_mvar as number, row.q_nom_mvar as number))) return fail();
    if (terminals && terminals.get(row.component_id) !== row.bus) return fail();
    seen.add(row.component_id);
  }
  if (terminals && (terminals.size !== seen.size || [...terminals.keys()].some(owner => !seen.has(owner)))) return fail();
}
