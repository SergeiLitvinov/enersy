import { expect, test } from 'vitest';
import { parseCalculationProvenance } from './calculation-provenance';

const input = { components: [{ id: 1, type: 'generator', x: 0, y: 0, rotation: 0, params: { power_nom: '12.00' } }], connections: [], modelGroup: 'three-phase', method: 'newton-raphson' };
export const evidence = { formatVersion: 1, components: [{ id: '1', revision: '9007199254740993', name: 'Источник', source: 'project-passport',
  passport: { versionId: '9007199254740993', revision: 1, sha256: 'a'.repeat(64), document: { formatVersion: 1, componentTypeCode: 'generator', name: 'Паспорт', manufacturer: '', source: 'Пример', license: 'Автор', parameters: { power_nom: { value: '10.00', unit: 'МВА' } } } } }] };

test('historical passport and component revision remain exact and independent of the source document', () => {
  const raw = JSON.parse(JSON.stringify(evidence)), parsed = parseCalculationProvenance(raw,input);
  expect(parsed.components[0].passport?.versionId).toBe('9007199254740993');
  expect(parsed.components[0].revision).toBe('9007199254740993');
  raw.components[0].passport.document.parameters.power_nom.value='999';
  expect(parsed.components[0].passport?.document.parameters.power_nom.value).toBe('10.00');
});
test('source must cover the exact captured equipment and cannot mix passport identities', () => {
  for (const change of [{ id: '2' }, { revision: 1 }, { source: 'instance' }, { equipmentModelId: '1' }, { passport: { ...evidence.components[0].passport, versionId: '9223372036854775808' } },
    { passport: { ...evidence.components[0].passport, document: { ...evidence.components[0].passport.document, componentTypeCode: 'load' } } }]) {
    expect(() => parseCalculationProvenance({ ...evidence, components: [{ ...evidence.components[0], ...change }] },input)).toThrow();
  }
  expect(() => parseCalculationProvenance({ ...evidence, components: [] },input)).toThrow();
  expect(() => parseCalculationProvenance({ ...evidence, components: [evidence.components[0],evidence.components[0]] },input)).toThrow();
});
