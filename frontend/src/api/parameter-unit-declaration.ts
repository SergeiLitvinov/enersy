export interface ParameterUnitDeclaration { formatVersion: 1; units: Record<string, string> }

/** Explicit instance labels; this is not a physical dimension or provenance certification. */
export function parseParameterUnitDeclaration(raw: unknown, params: Readonly<Record<string, unknown>>): ParameterUnitDeclaration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректная декларация единиц экземпляра');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, 'formatVersion') || value.formatVersion !== 1 || !Object.prototype.hasOwnProperty.call(value, 'units') ||
      !value.units || typeof value.units !== 'object' || Array.isArray(value.units)) throw new Error('Неподдержанная декларация единиц экземпляра');
  const entries = Object.entries(value.units);
  if (!entries.length || !entries.every(([key, unit]) => Object.prototype.hasOwnProperty.call(params, key) &&
    typeof unit === 'string' && unit.length > 0 && [...unit].length <= 64 && unit.trim() === unit && !/\p{Cc}/u.test(unit))) {
    throw new Error('Некорректные единицы экземпляра');
  }
  return { formatVersion: 1, units: Object.fromEntries(entries) as Record<string, string> };
}

export function parameterUnitLabel(declaration: ParameterUnitDeclaration | undefined, key: string, fallback: string): string {
  return declaration && Object.prototype.hasOwnProperty.call(declaration.units, key) ? declaration.units[key] : fallback;
}
