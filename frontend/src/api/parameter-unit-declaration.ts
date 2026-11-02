import { parseParameterBase, type ParameterBase } from '../domain/parameter-base';

export interface ParameterUnitDeclaration { formatVersion: 1 | 2; units: Record<string, string>; bases?: Record<string, ParameterBase | null> }

export function parameterSourceBase(declaration: ParameterUnitDeclaration | undefined, key: string): ParameterBase | null | undefined {
  return declaration?.bases && Object.prototype.hasOwnProperty.call(declaration.bases, key) ? declaration.bases[key] : undefined;
}

/** Explicit instance labels; this is not a physical dimension or provenance certification. */
export function parseParameterUnitDeclaration(raw: unknown, params: Readonly<Record<string, unknown>>): ParameterUnitDeclaration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректная декларация единиц экземпляра');
  const value = raw as Record<string, unknown>;
  if ((value.formatVersion !== 1 && value.formatVersion !== 2) || Object.keys(value).length !== (value.formatVersion === 1 ? 2 : 3) || !Object.prototype.hasOwnProperty.call(value, 'formatVersion') || !Object.prototype.hasOwnProperty.call(value, 'units') ||
      !value.units || typeof value.units !== 'object' || Array.isArray(value.units)) throw new Error('Неподдержанная декларация единиц экземпляра');
  const entries = Object.entries(value.units);
  if (!entries.length || !entries.every(([key, unit]) => Object.prototype.hasOwnProperty.call(params, key) &&
    typeof unit === 'string' && unit.length > 0 && [...unit].length <= 64 && unit.trim() === unit && !/\p{Cc}/u.test(unit))) {
    throw new Error('Некорректные единицы экземпляра');
  }
  const units = Object.fromEntries(entries) as Record<string, string>;
  if (value.formatVersion === 1) return { formatVersion: 1, units };
  if (!Object.prototype.hasOwnProperty.call(value, 'bases') || !value.bases || typeof value.bases !== 'object' || Array.isArray(value.bases)) throw new Error('Ожидаются исходные базисы декларации v2');
  const bases = Object.entries(value.bases);
  if (!bases.length || bases.length > 256) throw new Error('Некорректный состав базисов');
  return { formatVersion: 2, units, bases: Object.fromEntries(bases.map(([key, base]) => {
    if (!Object.prototype.hasOwnProperty.call(units, key) || units[key] !== 'p.u.') throw new Error('Базис требует значение и единицу p.u. того же параметра');
    return [key, base === null ? null : parseParameterBase(base)];
  })) };
}

export function copyParameterUnits(value: ParameterUnitDeclaration): ParameterUnitDeclaration {
  return { formatVersion: value.formatVersion, units: { ...value.units }, ...(value.bases ? {
    bases: Object.fromEntries(Object.entries(value.bases).map(([key, base]) => [key, base == null ? null : { ...base }])) } : {}) };
}

/** Mirror atomic server label edits; absence of a new base retains a p.u. base. */
export function editParameterUnit(original: ParameterUnitDeclaration | undefined, key: string, unit: string): ParameterUnitDeclaration {
  return mergeParameterUnits(original, { formatVersion: 1, units: { [key]: unit } });
}

export function mergeParameterUnits(original: ParameterUnitDeclaration | undefined, override: ParameterUnitDeclaration): ParameterUnitDeclaration {
  const units = { ...original?.units, ...override.units };
  const bases = copyParameterUnits(original ?? { formatVersion: 1, units: {} }).bases ?? {};
  for (const [key, unit] of Object.entries(override.units)) if (unit !== 'p.u.') delete bases[key];
  for (const [key, base] of Object.entries(override.bases ?? {})) {
    if (base === null) delete bases[key];
    else Object.defineProperty(bases, key, { value: { ...base }, enumerable: true, configurable: true, writable: true });
  }
  return Object.keys(bases).length ? { formatVersion: 2, units, bases } : { formatVersion: 1, units };
}

export function parameterUnitLabel(declaration: ParameterUnitDeclaration | undefined, key: string, fallback: string): string {
  return declaration && Object.prototype.hasOwnProperty.call(declaration.units, key) ? declaration.units[key] : fallback;
}
