import { expect, test } from 'vitest';
import dto from '../../../backend-julia/src/dto.jl?raw';
import { switchDisplay } from './switch-position';

test('display accepts exactly the legacy worker boolean vocabulary', () => {
  const body = dto.slice(dto.indexOf('function param_bool'), dto.indexOf('function _missing_param'));
  for (const [position, result] of [['closed', 'true'], ['open', 'false']] as const) {
    const literals = body.match(new RegExp(`raw in \\(([^)]+)\\) && return ${result}`))![1];
    const values = [...literals.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    expect(values.length).toBe(6);
    for (const value of values) expect(switchDisplay('breaker', { status: ` ${value.toUpperCase()} ` }).position).toBe(position);
  }
});
test('catalog, explicit state, worker default and unknown state remain distinguishable', () => {
  expect(switchDisplay('breaker').position).toBe('catalog');
  expect(switchDisplay('breaker', {}).position).toBe('closed');
  expect(switchDisplay('breaker', {}).description).toContain('допущение');
  expect(switchDisplay('grounding_switch', {}).position).toBe('unknown');
  for (const value of ['', ' ', 'enabled', '2']) expect(switchDisplay('disconnector', { status: value }).position).toBe('unknown');
  expect(switchDisplay('grounding_switch', { status: 'false' }).position).toBe('open');
});
