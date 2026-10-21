import { expect, test } from 'vitest';
import { modelParameterRows, unlistedModelParameters, type ModelParameterSpec } from './model-parameters';
const specs: ModelParameterSpec[] = [ { key: 'p', name: 'Power', unit: 'MW', kind: 'number', requirement: 'required', default_value: null, note: 'Three phase' }, { key: 'q', name: 'Reactive', unit: 'Mvar', kind: 'number', requirement: 'optional', default_value: '0', note: 'Three phase' } ];
test('preserves missing, empty and stored zero values without parsing or writing defaults', () => {
  const values = Object.freeze({ p: '  ', extra: '0' }); const original = JSON.stringify(values);
  expect(modelParameterRows(specs, values).map(row => [row.value,row.presence])).toEqual([['  ','empty'],[undefined,'missing']]);
  expect(modelParameterRows(specs, {p:'NaN',q:'0'}).map(row=>row.presence)).toEqual(['stored','stored']);
  expect(unlistedModelParameters(specs,values)).toEqual([['extra','0']]); expect(JSON.stringify(values)).toBe(original);
});
test('inherited properties cannot satisfy a required model input', () => {
  expect(modelParameterRows(specs,Object.create({p:'100'}))[0].presence).toBe('missing');
});
