import { expect, test } from 'vitest';
import { parseStudySnapshot } from './study-snapshot';
import type { StudyVersion } from '../../api/studies-api';
const document: StudyVersion['document'] = { formatVersion: 1, name: 'AC', modelGroup: 'three-phase', method: 'newton-raphson', computeBackend: 'julia', maxTimeMs: 20000, base: { s_base_mva: 100, v_base_kv: 10 }, solverOptions: { tolerance: 1e-8, max_iterations: 50 }, operatingLimits: [] };
const version: StudyVersion = { status: 'captured', id: '9007199254740994', revision: '2', projectId: '8', schemeId: '7', schemeName: 'S', topologyRevision: '0', authorAccountId: '2', createdAt: '2026-10-25T00:00:00Z', inputSha256: 'a'.repeat(64), provenanceSha256: 'b'.repeat(64), inputBytes: 1, provenanceBytes: 1, document };
const raw = () => ({ modelGroup: document.modelGroup, method: document.method, computeBackend: document.computeBackend, base: document.base, solverOptions: document.solverOptions, operatingLimits: [], executionOptions: { max_time_ms: 20000 }, studyReference: { formatVersion: 1, id: version.id, revision: version.revision }, components: [{ id: 4, type: 'load', x: 0, y: 0, rotation: 0, params: { p: '0.2' } }], connections: [] });
const evidence = { formatVersion: 1, components: [{ id: '4', revision: '3', name: 'Нагрузка', source: 'instance' }] };

test('snapshot cannot add or drop the selected versioned unit policy', () => {
  const unitContract = { formatVersion: 1 as const, profile: 'legacy-ac-three-phase-rms-v1' as const };
  const strictVersion = { ...version, document: { ...document, unitContract } };
  const value = { ...raw(), unitContract, components: [{ ...raw().components[0], parameterUnits: { p: 'MW' } }] };
  expect(parseStudySnapshot(value, evidence, strictVersion).input.unitContract).toEqual(unitContract);
  expect(() => parseStudySnapshot(raw(), evidence, strictVersion)).toThrow();
  expect(() => parseStudySnapshot(value, evidence, version)).toThrow();
  expect(() => parseStudySnapshot({ ...value, components: raw().components }, evidence, strictVersion)).toThrow();
  expect(() => parseStudySnapshot({ ...value, components: [{ ...value.components[0], parameterUnits: {} }] }, evidence, strictVersion)).toThrow();
});
test('frozen input must match Study identity, options and component provenance', () => {
  expect(parseStudySnapshot(raw(), evidence, version).input.components[0].params.p).toBe('0.2');
  for (const changed of [{ ...raw(), studyReference: { ...raw().studyReference, revision: '1' } }, { ...raw(), base: { ...document.base, v_base_kv: 20 } }, { ...raw(), computeBackend: 'julia-rust-jacobian' }, { ...raw(), executionOptions: { max_time_ms: 1000 } }, { ...raw(), modelGroup: 'phase' }]) expect(() => parseStudySnapshot(changed, evidence, version)).toThrow();
  expect(() => parseStudySnapshot(raw(), { formatVersion: 1, components: [] }, version)).toThrow();
});

test('Study keeps captured units and rejects damaged declarations without consulting current equipment', () => {
  const value = raw();
  const component = { ...value.components[0], parameterUnits: { p: 'МВт' } };
  expect(parseStudySnapshot({ ...value, components: [component] }, evidence, version).input.components[0].parameterUnits?.p).toBe('МВт');
  for (const units of [null, { p: 10 }, { absent: 'MW' }]) {
    expect(() => parseStudySnapshot({ ...value, components: [{ ...component, parameterUnits: units }] }, evidence, version)).toThrow();
  }
});
