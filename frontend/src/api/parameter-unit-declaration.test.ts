import { expect, test } from 'vitest';
import { parameterUnitLabel, parseParameterUnitDeclaration } from './parameter-unit-declaration';

test('explicit labels survive independently of a current template and are copied', () => {
  const source = { formatVersion: 1, units: { p: 'МВт' } };
  const declaration = parseParameterUnitDeclaration(source, { p: '1.2300' });
  source.units.p = 'W';
  expect(parameterUnitLabel(declaration, 'p', 'W')).toBe('МВт');
  expect(parameterUnitLabel(declaration, 'constructor', 'fallback')).toBe('fallback');
  expect(parameterUnitLabel(undefined, 'p', 'W')).toBe('W');
});

test('malformed metadata never becomes an instance declaration', () => {
  for (const raw of [null, {}, { formatVersion: 2, units: { p: 'MW' } }, { formatVersion: 1, units: {} },
    { formatVersion: 1, units: { missing: 'MW' } }, { formatVersion: 1, units: { p: '' } },
    { formatVersion: 1, units: { p: ' MW' } }, { formatVersion: 1, units: { p: 'MW\n' } },
    { formatVersion: 1, units: { p: 10 } }, { formatVersion: 1, units: { p: 'MW' }, extra: true }]) {
    expect(() => parseParameterUnitDeclaration(raw, { p: '1.2300' })).toThrow();
  }
});

test('a stored component can accumulate declarations across several bounded patches', () => {
  const params = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`parameter_${i}`, '1.0000']));
  const units = Object.fromEntries(Object.keys(params).map(key => [key, '1']));
  expect(Object.keys(parseParameterUnitDeclaration({ formatVersion: 1, units }, params).units)).toHaveLength(257);
});
