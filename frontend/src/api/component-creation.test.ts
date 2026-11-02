import { expect, test } from 'vitest';
import fixtureJSON from '../../../tests/fixtures/editor-create-units-v1.json?raw';
import { copyComponentCreation, requireCreationUnits } from './component-creation';
import { encodeEditorDraftPayload, parseEditorDraftPayload } from './editor-draft-payload';

test('creation units survive the shared recovery contract without conversion or shared mutable maps', () => {
  const source = JSON.parse(fixtureJSON);
  const parsed = parseEditorDraftPayload(source);
  expect(JSON.parse(encodeEditorDraftPayload(parsed))).toEqual(source);
  source.graph[0].intent.parameterUnitDeclaration.units.p = 'Вт';
  expect(parsed.graph[0].intent).toMatchObject({ params: { p: '1.2300' }, parameterUnitDeclaration: { units: { p: 'МВт' } } });
  const input = { schemeId: 7, typeId: 9, name: 'Нагрузка', x: 10, y: 20, rotation: 0,
    params: { p: '1.2300' }, parameterUnitDeclaration: { formatVersion: 1 as const, units: { p: 'МВт' } } };
  const copied = copyComponentCreation(input);
  input.params.p = '2'; input.parameterUnitDeclaration.units.p = 'Вт';
  expect(copied.params.p).toBe('1.2300');
  expect(copied.parameterUnitDeclaration?.units.p).toBe('МВт');
  expect(() => requireCreationUnits(copied.parameterUnitDeclaration, copied.params, { params: copied.params })).toThrow();
  expect(() => requireCreationUnits(copied.parameterUnitDeclaration, copied.params,
    { params: { p: '1.23' }, declaredParameterUnits: copied.parameterUnitDeclaration })).toThrow();
  expect(() => requireCreationUnits(copied.parameterUnitDeclaration, copied.params,
    { params: copied.params, declaredParameterUnits: copied.parameterUnitDeclaration })).not.toThrow();
});

test('creation recovery rejects missing values and malformed declarations', () => {
  for (const declaration of [null, { formatVersion: 2, units: { p: 'МВт' } },
    { formatVersion: 1, units: { absent: 'МВт' } }, { formatVersion: 1, units: { p: '' } }]) {
    const source = JSON.parse(fixtureJSON);
    source.graph[0].intent.parameterUnitDeclaration = declaration;
    expect(() => parseEditorDraftPayload(source)).toThrow();
  }
});
