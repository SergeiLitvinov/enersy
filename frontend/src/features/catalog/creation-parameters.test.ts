import { expect, test } from 'vitest';
import { creationParameters } from './creation-parameters';

const template = [{ key: 'voltage_nom', name: 'Напряжение', type: 'number', unit: 'кВ', default: '110' }];
test('creation overrides preserve exact values and explicit units without using template defaults', () => {
  expect(creationParameters([], template)).toEqual({ params: {} });
  expect(creationParameters([{ id: 1, key: 'voltage_nom', value: '10500.0000', unit: 'В' }], template))
    .toEqual({ params: { voltage_nom: '10500.0000' }, parameterUnitDeclaration: { formatVersion: 1, units: { voltage_nom: 'В' } } });
  expect(creationParameters([{ id: 1, key: 'description', value: 'Свои данные', unit: '' }], template))
    .toEqual({ params: { description: 'Свои данные' } });
});
test('invalid or duplicate overrides cannot be silently truncated, coerced or given template units', () => {
  for (const row of [{ key: '', value: '1', unit: '1' }, { key: 'voltage_nom', value: 'bad', unit: '' },
    { key: 'custom', value: '1.20e3', unit: '' }, { key: 'p', value: '', unit: 'МВт' },
    { key: 'p', value: '1', unit: ' MW' }]) {
    expect(() => creationParameters([{ ...row, id: 1 }], template)).toThrow();
  }
  const row = { id: 1, key: 'p', value: '1', unit: 'МВт' };
  expect(() => creationParameters([row, { ...row, id: 2 }], template)).toThrow('несколько раз');
});
