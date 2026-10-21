import { parseComponentRevision } from './component-revision';
import { parsePassportDocument, type PassportDocument } from '../domain/passport-document';
import type { ArchiveInput } from './calculation-archives-api';

export interface ComponentProvenance {
  id: string; revision: string; name: string; source: 'instance' | 'legacy-catalog' | 'project-passport';
  equipmentModelId?: string;
  passport?: { versionId: string; revision: number; sha256: string; document: PassportDocument };
}
export interface CalculationProvenance { formatVersion: 1; components: ComponentProvenance[] }
const fail = (): never => { throw new Error('Некорректное происхождение данных расчёта'); };
const row = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(); return v as Record<string, unknown>; };
export function parseCalculationProvenance(raw: unknown, input: ArchiveInput): CalculationProvenance {
  const doc = row(raw), seen = new Set<string>();
  if (doc.formatVersion !== 1 || !Array.isArray(doc.components) || doc.components.length !== input.components.length) return fail();
  const originals = new Map(input.components.map(c => [String(c.id), c]));
  const components = doc.components.map((raw): ComponentProvenance => {
    const item = row(raw), id = parseComponentRevision(item.id), original = originals.get(id);
    if (!original || seen.has(id) || typeof item.name !== 'string' || [...item.name].length > 100 || item.name.includes('\0')) return fail();
    seen.add(id);
    const base = { id, revision: parseComponentRevision(item.revision), name: item.name };
    if (item.source === 'instance' && item.equipmentModelId === undefined && item.passport === undefined) return { ...base, source: 'instance' };
    if (item.source === 'legacy-catalog' && item.passport === undefined) {
      const equipmentModelId = parseComponentRevision(item.equipmentModelId);
      if (BigInt(equipmentModelId) > 2147483647n) return fail();
      return { ...base, source: 'legacy-catalog', equipmentModelId };
    }
    if (item.source !== 'project-passport' || item.equipmentModelId !== undefined) return fail();
    const passport = row(item.passport), versionId = parseComponentRevision(passport.versionId), document = parsePassportDocument(passport.document);
    if (document.componentTypeCode !== original.type || !Number.isSafeInteger(passport.revision) || (passport.revision as number) < 1 ||
      typeof passport.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(passport.sha256)) return fail();
    return { ...base, source: 'project-passport', passport: { versionId, revision: passport.revision as number, sha256: passport.sha256, document } };
  });
  return { formatVersion: 1, components };
}
