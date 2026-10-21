/** Read-only projection of the current AC legacy terminal contract.
 * IDs are local to the current scheme. This is neither a new persisted domain
 * schema nor a topology compiler: it does not merge nodes or interpret switches.
 * Reference: backend-julia/src/topology.jl and the connection-integrity migration.
 */
export interface TerminalDefinition {
  readonly ordinal: number;
  readonly aliases: readonly string[];
}
const definitions: Readonly<Record<string, readonly (readonly string[])[]>> = {
  generator: [['top', 'bottom']],
  busbar: [['left', 'right']],
  load: [['top']], ground: [['top']], grounding_switch: [['top']],
  capacitor: [['top']], reactor: [['top']],
  breaker: [['top'], ['bottom']], disconnector: [['top'], ['bottom']],
  transmission_line: [['left', 'top'], ['right', 'bottom']],
  transformer: [['top', 'left', 'a'], ['bottom', 'right', 'b']],
  autotransformer: [['top', 'left', 'a'], ['bottom', 'right', 'b']],
  transformer_3w: [['top', 'left'], ['bl', 'right', 'bottom'], ['br']],
};
export function equipmentTerminals(type: string): readonly TerminalDefinition[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(definitions, type)) return undefined;
  // Return independent data so callers cannot mutate the shared contract.
  return definitions[type].map((aliases, index) => ({ ordinal: index + 1, aliases: [...aliases] }));
}
export function terminalForPort(type: string, port: string): number | undefined {
  return equipmentTerminals(type)?.find(terminal => terminal.aliases.includes(port.toLowerCase()))?.ordinal;
}
export interface EquipmentReference { readonly id: number; readonly type: string; readonly name: string }
export interface ConnectionReference { readonly id: number; readonly from: number; readonly to: number; readonly fromPort: string; readonly toPort: string; readonly validationErrors?: readonly string[] }
export type EndpointDescription =
  | { readonly status: 'resolved'; readonly equipment: EquipmentReference; readonly port: string; readonly terminal: number }
  | { readonly status: 'unresolved'; readonly equipmentId: number; readonly port: string; readonly reason: string };
export function indexEquipment(components: readonly EquipmentReference[]): ReadonlyMap<number, EquipmentReference | null> {
  const index = new Map<number, EquipmentReference | null>();
  for (const item of components) index.set(item.id, index.has(item.id) ? null : item);
  return index;
}
export function describeEndpoint(index: ReadonlyMap<number, EquipmentReference | null>, equipmentId: number, port: string): EndpointDescription {
  const equipment = index.get(equipmentId);
  if (!equipment) return { status: 'unresolved', equipmentId, port, reason: index.has(equipmentId) ? 'Повторяется ID объекта' : 'Объект отсутствует в загруженной схеме' };
  const terminal = terminalForPort(equipment.type, port);
  if (terminal === undefined) return { status: 'unresolved', equipmentId, port, reason: equipmentTerminals(equipment.type) ? 'Неизвестный порт' : 'Неизвестный терминальный контракт типа' };
  return { status: 'resolved', equipment: { id: equipment.id, type: equipment.type, name: equipment.name }, port, terminal };
}
/** Incident endpoint records; every connection is retained, including invalid ones. */
export function equipmentConnections(equipmentId: number, connections: readonly ConnectionReference[]) {
  return connections.flatMap(connection => {
    const endpoints: { connection: ConnectionReference; localPort: string; remoteId: number; remotePort: string }[] = [];
    if (connection.from === equipmentId) endpoints.push({ connection, localPort: connection.fromPort, remoteId: connection.to, remotePort: connection.toPort });
    if (connection.to === equipmentId) endpoints.push({ connection, localPort: connection.toPort, remoteId: connection.from, remotePort: connection.fromPort });
    return endpoints;
  });
}
