import { expect, test } from 'vitest';
import { calculationPhysicalKey, calculationSelectionKey, type CalculationSelection } from './calculation-context';
import type { SchemeComponent } from '../../api/ees-api';
import { ComponentWrites } from './component-writes';
const component: SchemeComponent = { id: 1, typeId: 1, type: 'breaker', name: 'Switch', revision: '1', x: 10, y: 20, rotation: 0,
  params: { status: 'true', x: '0.1000' }, declaredParameterUnits: { formatVersion: 2, units: { status: '1', x: 'p.u.' }, bases: { x: { profile: 'ac-three-phase-rms-v1', s_base_mva: 10, v_base_kv: 110 } } } };
const connection = { id: 3, from: 1, to: 2, fromPort: 'top', toPort: 'bottom' };
const key = (value = component) => calculationPhysicalKey([value], [connection], 'based-ac-three-phase-rms-v3');

test('physical display context ignores drawing, captions, revisions and object order', () => {
  expect(key({ ...component, name: 'New caption', revision: '999', x: 999, y: 100, rotation: 90 })).toBe(key());
  const next = { ...component, id: 2 };
  expect(calculationPhysicalKey([component, next], [connection], 'v3')).toBe(calculationPhysicalKey([next, component], [connection], 'v3'));
  expect(key({ ...component, params: { x: '0.1000', status: 'true' } })).toBe(key());
});
test('parameters, switch status, units, bases, bindings and connections change result context', () => {
  for (const value of [
    { ...component, params: { ...component.params, status: 'false' } },
    { ...component, params: { ...component.params, x: '0.2000' } },
    { ...component, equipmentModelId: 8 }, { ...component, projectPassportVersionId: '9' },
    { ...component, declaredParameterUnits: { formatVersion: 1 as const, units: { status: '1', x: 'Ом' } } },
    { ...component, declaredParameterUnits: { ...component.declaredParameterUnits!, bases: { x: { profile: 'ac-three-phase-rms-v1' as const, s_base_mva: 20, v_base_kv: 110 } } } },
  ]) expect(key(value)).not.toBe(key());
  expect(calculationPhysicalKey([component], [{ ...connection, toPort: 'left' }], 'based-ac-three-phase-rms-v3')).not.toBe(key());
});
test('legacy fallback units are observed without treating UI template defaults as physics', () => {
  const source = { ...component, params: { voltage_nom: '110' }, declaredParameterUnits: undefined,
    paramTemplate: [{ key: 'voltage_nom', name: 'Voltage', unit: 'кВ', type: 'number', default: '999' }] };
  const changed = { ...source, paramTemplate: [{ ...source.paramTemplate[0], unit: 'В' }] };
  expect(calculationPhysicalKey([source], [], 'legacy-ac-three-phase-rms-v1')).not.toBe(calculationPhysicalKey([changed], [], 'legacy-ac-three-phase-rms-v1'));
  expect(calculationPhysicalKey([source], [], 'based-ac-three-phase-rms-v3')).toBe(calculationPhysicalKey([changed], [], 'based-ac-three-phase-rms-v3'));
  expect(calculationPhysicalKey([source], [], 'legacy-ac-three-phase-rms-v1')).toBe(calculationPhysicalKey([{ ...source, paramTemplate: [{ ...source.paramTemplate[0], default: '1000' }] }], [], 'legacy-ac-three-phase-rms-v1'));
});
test('calculation selection captures method, engine, units, budget and limits independent of order', () => {
  const selection: CalculationSelection = { modelGroup: 'three-phase', method: 'newton', backend: 'julia', unitProfile: 'v3', maxTimeMs: 1000,
    limits: [{ component_id: 1, terminal: 0, min_kv: 1, max_kv: 2 }, { component_id: 2, terminal: 1, min_kv: 10, max_kv: 20 }] };
  const original = calculationSelectionKey(selection);
  expect(calculationSelectionKey({ ...selection, limits: [...selection.limits].reverse() })).toBe(original);
  for (const change of [{ method: 'other' }, { backend: 'rust' }, { unitProfile: 'v2' }, { maxTimeMs: 2000 }, { limits: [] }]) expect(calculationSelectionKey({ ...selection, ...change })).not.toBe(original);
});
test('physical activity tracks parameter/graph changes but permits ordinary drawing writes', async () => {
  const queue = new ComponentWrites(); queue.seed(1, component); const original = queue.calculationVersion;
  await queue.pose(component, pose => ({ ...pose, rotation: 90 }), () => true, async () => ({ success: true, revision: '2' }), 1);
  expect(queue.calculationVersion).toBe(original);
  await queue.run(component, () => true, async () => ({ success: true, revision: '3' }), { schemeId: 1, intent: { kind: 'parameter', key: 'status', value: 'false' } });
  expect(queue.calculationVersion).not.toBe(original); const parameter = queue.calculationVersion;
  await queue.graph.run(1, { kind: 'delete-connection', id: 3 }, async () => undefined);
  expect(queue.calculationVersion).not.toBe(parameter);
});
