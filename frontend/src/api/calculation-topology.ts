export type CalculationTerminal = {
  component_id: number; component_type: string; terminal: number;
} & ({ bus_id: number; omitted_reason: null } | { bus_id: null; omitted_reason: 'unused_switch' });
export interface CalculationInternalNode { bus_id: number; component_id: number; role: 'source_emf' }
export interface CalculationTopology {
  schema_version: 1;
  node_numbering: 'min-component-terminal';
  terminals: CalculationTerminal[];
  internal_nodes: CalculationInternalNode[];
}
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
export function parseCalculationTopology(raw: unknown, buses: ReadonlySet<number>, sources: readonly SourceReference[]): CalculationTopology {
  const value = row(raw);
  if (value.schema_version !== 1 || value.node_numbering !== 'min-component-terminal' ||
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
  return raw as CalculationTopology;
}
