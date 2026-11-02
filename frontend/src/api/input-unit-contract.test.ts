import { expect, test } from 'vitest';
import { AC_INPUT_UNIT_PROFILE, SCALED_AC_INPUT_UNIT_PROFILE, parseInputUnitContract, requireInputUnitContract } from './input-unit-contract';

test('scaled Study policy round-trips while editor v1 still requires its own acknowledgement', () => {
  const value = { formatVersion: 1, profile: SCALED_AC_INPUT_UNIT_PROFILE };
  expect(parseInputUnitContract(value)).toEqual(value);
  expect(() => requireInputUnitContract({ input_unit_contract: { ...confirmation, profile: SCALED_AC_INPUT_UNIT_PROFILE, validation_scope: 'request-declarations-with-scale-normalization' } })).toThrow();
});

const confirmation = { formatVersion: 1, profile: AC_INPUT_UNIT_PROFILE, validation_scope: 'request-declarations-only', component_count: 2, parameter_count: 3 };
test('UI requires the exact strict-unit acknowledgement and valid coverage counters', () => {
  requireInputUnitContract({ input_unit_contract: confirmation });
  for (const input_unit_contract of [undefined, null, {}, { ...confirmation, profile: 'other' }, { ...confirmation, formatVersion: 2 },
    { ...confirmation, validation_scope: 'physical-certification' }, { ...confirmation, component_count: -1 },
    { ...confirmation, parameter_count: '3' }, { ...confirmation, parameter_count: 1.5 }, { ...confirmation, extra: true }]) {
    expect(() => requireInputUnitContract({ input_unit_contract })).toThrow('не подтвердил');
  }
});
