import juliaTopology from '../../../backend-julia/src/topology.jl?raw';
import sqlPorts from '../../../database/migrations/20260930002_connection_integrity.up.sql?raw';
import { describe, expect, it } from 'vitest';
import { describeEndpoint, indexEquipment, equipmentConnections, equipmentTerminals, terminalForPort } from './equipment-terminals';
describe('legacy terminal projection', () => {
  it('distinguishes aliases of one source terminal from two branch terminals', () => {
    expect(terminalForPort('generator', 'top')).toBe(1); expect(terminalForPort('generator', 'bottom')).toBe(1);
    expect(terminalForPort('busbar', 'left')).toBe(terminalForPort('busbar', 'right'));
    expect(terminalForPort('transmission_line', 'left')).toBe(1); expect(terminalForPort('transmission_line', 'right')).toBe(2);
    expect(terminalForPort('transformer', 'a')).toBe(1); expect(terminalForPort('transformer', 'b')).toBe(2);
    expect(terminalForPort('transformer_3w', 'br')).toBe(3);
  });
  it('does not replace unknown or inherited keys with the first terminal', () => {
    for (const type of ['unknown', '__proto__', 'constructor']) expect(equipmentTerminals(type)).toBeUndefined();
    expect(terminalForPort('generator', 'left')).toBeUndefined(); expect(terminalForPort('generator', '')).toBeUndefined();
  });
  it('resolves identity independently of layout and rejects missing or ambiguous objects', () => {
    const item = { id: 7, type: 'transformer', name: 'T', x: 0, y: 0, rotation: 0 };
    const endpoint = describeEndpoint(indexEquipment([item]), 7, 'BOTTOM');
    expect(endpoint).toEqual({ status: 'resolved', equipment: { id: 7, type: 'transformer', name: 'T' }, port: 'BOTTOM', terminal: 2 });
    const moved = { ...item, x: 999, rotation: 270 };
    expect(describeEndpoint(indexEquipment([moved]), 7, 'BOTTOM')).toEqual(endpoint);
    expect(describeEndpoint(indexEquipment([]), 7, 'top').status).toBe('unresolved');
    expect(describeEndpoint(indexEquipment([item, item]), 7, 'top').status).toBe('unresolved');
  });
  it('retains invalid, parallel and both self-connection endpoints without inferring switching state', () => {
    const edge = { id: 1, from: 7, to: 8, fromPort: 'top', toPort: 'left', validationErrors: ['bad'] };
    const connections = equipmentConnections(7, [edge, { ...edge, id: 2 }, { id: 3, from: 7, to: 7, fromPort: 'top', toPort: 'bottom' }]);
    expect(connections).toHaveLength(4); expect(connections[0].connection.validationErrors).toEqual(['bad']);
    expect(connections.map(item => item.remotePort)).toEqual(['left', 'left', 'bottom', 'top']);
  });
  it('protects registry values from consumer mutations', () => {
    const terminals = equipmentTerminals('generator')!; (terminals[0].aliases as string[]).push('wrong');
    expect(terminalForPort('generator', 'wrong')).toBeUndefined();
  });
});



// A static conformance guard, not a numerical solver test. Any source-format
// change must be reviewed rather than silently weakening this comparison.
it('matches the existing SQL port set and Julia multi-terminal aliases', () => {
  const sqlTypes = new Map<string, string[]>();
  for (const match of sqlPorts.matchAll(/\('([a-z0-9_]+)','([a-z0-9_]+)'\)/g)) {
    sqlTypes.set(match[1], [...(sqlTypes.get(match[1]) ?? []), match[2]]);
  }
  expect(sqlTypes.size).toBe(13);
  for (const [type, ports] of sqlTypes) expect(equipmentTerminals(type)?.flatMap(terminal => terminal.aliases).sort()).toEqual(ports.sort());
  const definitions = [...juliaTopology.matchAll(/"([a-z0-9_]+)" => Dict\(([^()\r\n]+)\)/g)];
  expect(definitions).toHaveLength(6);
  for (const [, type, aliases] of definitions) {
    for (const alias of aliases.matchAll(/"([a-z0-9_]+)" => ([1-3])/g)) expect(terminalForPort(type, alias[1])).toBe(Number(alias[2]));
  }
});
