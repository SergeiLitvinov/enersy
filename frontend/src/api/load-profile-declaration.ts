import { loadProfileUnits, type LoadProfileDraft } from '../domain/load-profile';
import { parseParameterBase } from '../domain/parameter-base';
import { parameterSourceBase, parameterUnitLabel, type ParameterUnitDeclaration } from './parameter-unit-declaration';

export type LoadUnitPolicy = 'canonical' | 'saved';

/** Captures primitive metadata, so an in-place source change cannot alter a draft. */
export function loadUnitContext(declaration: ParameterUnitDeclaration | undefined, key: string): string {
  const base = parameterSourceBase(declaration, key);
  return JSON.stringify([parameterUnitLabel(declaration, key, ''), base?.profile ?? null, base?.s_base_mva ?? null, base?.v_base_kv ?? null]);
}

/** No conversion or Study/catalogue fallback. Empty optional fields are explicitly
 * declared in canonical units when they do not yet have a saved unit. */
export function loadProfileDeclaration(policy: LoadUnitPolicy, draft: LoadProfileDraft, saved: ParameterUnitDeclaration | undefined): ParameterUnitDeclaration {
  const units: Record<string, string> = { ...loadProfileUnits };
  const bases: NonNullable<ParameterUnitDeclaration['bases']> = {};
  if (policy === 'saved') for (const key of ['p', 'q', 'voltage_nom'] as const) {
    const unit = parameterUnitLabel(saved, key, '');
    if (!unit && draft[key].trim()) throw new Error(`Сначала задайте единицу параметра ${key} через «Задать значение и единицу».`);
    if (unit) units[key] = unit;
    if (unit === 'p.u.') {
      const base = parameterSourceBase(saved, key);
      if (!base) throw new Error(`Для ${key} в p.u. сначала задайте исходные Sб и Uб.`);
      bases[key] = parseParameterBase(base);
    }
  }
  return Object.keys(bases).length ? { formatVersion: 2, units, bases } : { formatVersion: 1, units };
}
