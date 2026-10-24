import { readStudyArtifact, type StudyVersion } from '../../api/studies-api';
import { parseArchiveInput, type ArchiveInput } from '../../api/calculation-archives-api';
import { parseCalculationProvenance, type CalculationProvenance } from '../../api/calculation-provenance';
import { parseTerminalVoltageLimits } from '../../api/operating-assessment';

export interface StudySnapshot { input: ArchiveInput; provenance: CalculationProvenance }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректный снимок исследования');
  return value as Record<string, unknown>;
};
export function parseStudySnapshot(raw: unknown, evidence: unknown, version: StudyVersion): StudySnapshot {
  const value = object(raw), reference = object(value.studyReference);
  const base = object(value.base), solver = object(value.solverOptions), execution = object(value.executionOptions);
  const doc = version.document;
  if (reference.formatVersion !== 1 || reference.id !== version.id || reference.revision !== version.revision ||
      value.computeBackend !== doc.computeBackend || base.s_base_mva !== doc.base.s_base_mva || base.v_base_kv !== doc.base.v_base_kv ||
      solver.tolerance !== doc.solverOptions.tolerance || solver.max_iterations !== doc.solverOptions.max_iterations ||
      execution.max_time_ms !== doc.maxTimeMs || JSON.stringify(parseTerminalVoltageLimits(value.operatingLimits)) !== JSON.stringify(doc.operatingLimits)) {
    throw new Error('Снимок не соответствует выбранной версии исследования');
  }
  const input = parseArchiveInput(raw, doc);
  return { input, provenance: parseCalculationProvenance(evidence, input) };
}
export async function readStudySnapshot(project: string, version: StudyVersion, signal: AbortSignal): Promise<StudySnapshot> {
  if (project !== version.projectId) throw new Error('Исследование другого проекта');
  const [input, provenance] = await Promise.all([
    readStudyArtifact(project, version.id, version.revision, 'input', signal),
    readStudyArtifact(project, version.id, version.revision, 'provenance', signal),
  ]);
  signal.throwIfAborted();
  const decode = (body: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  return parseStudySnapshot(decode(input), decode(provenance), version);
}
