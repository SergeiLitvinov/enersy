export type CalculationTerminal = {
  component_id: number; component_type: string; terminal: number;
} & ({ bus_id: number; omitted_reason: null } | { bus_id: null; omitted_reason: 'unused_switch' });
export interface CalculationInternalNode { bus_id: number; component_id: number; role: 'source_emf' }
export type CalculationBranchEndpoint = { kind: 'terminal'; terminal: number } | { kind: 'internal'; role: 'source_emf' };
export interface CalculationBranchOrigin {
  component_id: number; component_type: 'generator' | 'transmission_line' | 'transformer';
  model_id: 'enersy.ac.source-impedance' | 'enersy.ac.line-pi' | 'enersy.ac.transformer-2w';
  role: 'source_impedance' | 'line_pi' | 'transformer_2w';
  from: CalculationBranchEndpoint; to: CalculationBranchEndpoint;
}
export interface CalculationTopologyBase {
  node_numbering: 'min-component-terminal';
  terminals: CalculationTerminal[];
  internal_nodes: CalculationInternalNode[];
}
export type CalculationTopology = CalculationTopologyBase & (
  { schema_version: 1; branch_origins?: never } |
  { schema_version: 2; branch_origins: CalculationBranchOrigin[] }
);
interface SourceReference { component_id: number; internal_bus: number; terminal_bus: number }
const fail = (): never => { throw new Error('Сервис вернул некорректную карту терминалов расчёта'); };
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
};
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Validate without inventing bindings or copying a potentially large graph.
 * All IDs refer to this result's global compiled nodes, not persistent identities.
 */
export function parseCalculationTopology(raw: unknown, buses: ReadonlySet<number>, sources: readonly SourceReference[], branches?: unknown): CalculationTopology {
  const value = row(raw);
  if (![1, 2].includes(value.schema_version as number) || value.node_numbering !== 'min-component-terminal' ||
      !Array.isArray(value.terminals) || value.terminals.length > 1_000_000 ||
      !Array.isArray(value.internal_nodes) || value.internal_nodes.length !== sources.length) return fail();
  const terminalKeys = new Set<string>(), covered = new Set<number>();
  const componentTypes = new Map<number, string>(), generatorBuses = new Map<number, number>();
  for (const raw of value.terminals) {
    const t = row(raw);
    if (!positive(t.component_id) || !positive(t.terminal) || typeof t.component_type !== 'string' ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(t.component_type)) return fail();
    const key = `${t.component_id}:${t.terminal}`;
    if (terminalKeys.has(key) || (componentTypes.has(t.component_id) && componentTypes.get(t.component_id) !== t.component_type)) return fail();
    terminalKeys.add(key); componentTypes.set(t.component_id, t.component_type);
    if (t.bus_id === null) {
      if (t.omitted_reason !== 'unused_switch' || !['breaker', 'disconnector'].includes(t.component_type)) return fail();
    } else {
      if (!positive(t.bus_id) || !buses.has(t.bus_id) || t.omitted_reason !== null) return fail();
      covered.add(t.bus_id);
    }
    if (t.component_type === 'generator') {
      if (t.terminal !== 1 || !positive(t.bus_id)) return fail();
      generatorBuses.set(t.component_id, t.bus_id);
    }
  }
  const sourceById = new Map(sources.map(source => [source.component_id, source]));
  const internalBuses = new Set<number>(), internalOwners = new Set<number>();
  for (const raw of value.internal_nodes) {
    const n = row(raw);
    if (!positive(n.component_id) || !positive(n.bus_id) || n.role !== 'source_emf' ||
        !buses.has(n.bus_id) || covered.has(n.bus_id) || internalBuses.has(n.bus_id) || internalOwners.has(n.component_id)) return fail();
    const source = sourceById.get(n.component_id);
    if (!source || source.internal_bus !== n.bus_id || generatorBuses.get(n.component_id) !== source.terminal_bus) return fail();
    internalBuses.add(n.bus_id); internalOwners.add(n.component_id);
  }
  if (covered.size + internalBuses.size !== buses.size || internalOwners.size !== generatorBuses.size) return fail();
  if (value.schema_version === 2) validateBranchOrigins(value, branches, sourceById, componentTypes);
  else if (value.branch_origins !== undefined) return fail();
  return raw as CalculationTopology;
}

/** Bind implementation identities to the actual flow endpoints, never layout. */
function validateBranchOrigins(value: Record<string, unknown>, branches: unknown, sources: ReadonlyMap<number, SourceReference>, componentTypes: ReadonlyMap<number, string>): void {
  if (!Array.isArray(value.branch_origins) || !Array.isArray(branches) || branches.length > 1_000_000 ||
      value.branch_origins.length !== branches.length) return fail();
  const flows = new Map<number, Record<string, unknown>>();
  const terminals = new Map((value.terminals as CalculationTerminal[]).map(t => [`${t.component_id}:${t.terminal}`, t]));
  for (const raw of branches) {
    const branch = row(raw);
    if (!positive(branch.component_id) || flows.has(branch.component_id) || !positive(branch.from_bus) || !positive(branch.to_bus)) return fail();
    flows.set(branch.component_id, branch);
  }
  const definitions = new Map<string, readonly [string, string]>([
    ['generator', ['enersy.ac.source-impedance', 'source_impedance']],
    ['transmission_line', ['enersy.ac.line-pi', 'line_pi']],
    ['transformer', ['enersy.ac.transformer-2w', 'transformer_2w']],
  ]);
  const owners = new Set<number>();
  for (const raw of value.branch_origins) {
    const o = row(raw);
    if (!positive(o.component_id) || owners.has(o.component_id)) return fail();
    const branch = flows.get(o.component_id);
    const expected = typeof o.component_type === 'string' ? definitions.get(o.component_type) : undefined;
    if (!branch || !expected || branch.code !== o.component_type || o.model_id !== expected[0] || o.role !== expected[1]) return fail();
    const from = row(o.from), to = row(o.to);
    const terminal = (ref: Record<string, unknown>, ordinal: number, bus: unknown) => {
      const t = terminals.get(`${o.component_id}:${ordinal}`);
      if (Object.keys(ref).length !== 2 || ref.kind !== 'terminal' || ref.terminal !== ordinal ||
          !t || t.component_type !== o.component_type || t.bus_id !== bus) return fail();
    };
    if (o.component_type === 'generator') {
      if (Object.keys(from).length !== 2 || from.kind !== 'internal' || from.role !== 'source_emf' ||
          sources.get(o.component_id)?.internal_bus !== branch.from_bus) return fail();
      terminal(to, 1, branch.to_bus);
    } else {
      terminal(from, 1, branch.from_bus); terminal(to, 2, branch.to_bus);
    }
    owners.add(o.component_id);
  }
  for (const [id, type] of componentTypes) if (definitions.has(type) && !owners.has(id)) return fail();
}
