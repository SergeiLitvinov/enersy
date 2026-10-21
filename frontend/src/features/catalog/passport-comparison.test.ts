import { describe, expect, it } from 'vitest';
import { passportRows } from './passport-comparison';
describe('passport comparison', () => {
  it('keeps missing, empty, zero and extra keys distinct without using defaults', () => {
    const rows = passportRows([{ key: 'p', name: 'Power', unit: 'MW', type: 'number', default: '100' }], [{ p: '', extra: '0' }, {}]);
    expect(rows).toEqual([{ key: 'p', name: 'Power', unit: 'MW', values: ['', undefined], different: true }, { key: 'extra', name: 'extra', unit: null, values: ['0', undefined], different: true }]);
  });
});
