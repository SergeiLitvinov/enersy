import { parseParameterBase, type ParameterBase } from './parameter-base';

export interface PassportParameter { value: string; unit: string; base?: ParameterBase }
export interface PassportDocument {
  formatVersion: 1 | 2; componentTypeCode: string; name: string; manufacturer: string;
  source: string; license: string; parameters: Record<string, PassportParameter>;
}
const fail = (): never => { throw new Error('Некорректный документ паспорта'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): value is string {
  return typeof value === 'string' && !value.includes('\0') && [...value].length <= max && (!required || !!value.trim());
}
export function parsePassportDocument(raw: unknown): PassportDocument {
  const v = record(raw), parameters = record(v.parameters);
  if ((v.formatVersion !== 1 && v.formatVersion !== 2) || !text(v.componentTypeCode, 50, true) || !text(v.name, 200, true) || !text(v.manufacturer, 200) ||
      !text(v.source, 4000, true) || !text(v.license, 200, true) || !Object.keys(parameters).length || Object.keys(parameters).length > 128) return fail();
  const entries = Object.entries(parameters).map(([key, raw]) => {
    const p = record(raw);
    if (!text(key, 50, true) || !text(p.value, 1000, true) || !text(p.unit, 20)) return fail();
    if (Object.prototype.hasOwnProperty.call(p, 'base') && (v.formatVersion !== 2 || p.unit !== 'p.u.')) return fail();
    return [key, { value: p.value, unit: p.unit, ...(Object.prototype.hasOwnProperty.call(p, 'base') ? { base: parseParameterBase(p.base) } : {}) }] as const;
  });
  return { formatVersion: v.formatVersion, componentTypeCode: v.componentTypeCode, name: v.name, manufacturer: v.manufacturer,
    source: v.source, license: v.license, parameters: Object.fromEntries(entries) };
}
