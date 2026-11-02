import type { ComponentParam } from '../../api/ees-api';
import { copyCreationParams, copyCreationUnits } from '../../api/component-creation';
import type { ParameterUnitDeclaration } from '../../api/parameter-unit-declaration';
import { parameterBaseDraft } from '../../domain/parameter-base';

export interface CreationParameterRow { id: number; key: string; value: string; unit: string; power?: string; voltage?: string }
export interface CreationParameters { params: Record<string, string>; parameterUnitDeclaration?: ParameterUnitDeclaration }

/** Explicit overrides only. Neither template defaults nor passport values are inferred. */
export function creationParameters(rows: readonly CreationParameterRow[], template: readonly ComponentParam[]): CreationParameters {
  if (rows.length > 256) throw new Error('Допускается не более 256 параметров экземпляра.');
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.key || row.key.trim() !== row.key) throw new Error('Укажите ключ каждого параметра без пробелов по краям.');
    if (seen.has(row.key)) throw new Error(`Параметр «${row.key}» указан несколько раз.`);
    seen.add(row.key);
    if (!row.value.trim()) throw new Error(`Укажите значение параметра «${row.key}».`);
    const numeric = template.some(item => item.key === row.key && item.type === 'number') ||
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(row.value.trim());
    if (numeric && !row.unit) throw new Error(`Укажите единицу параметра «${row.key}»; для безразмерной величины — 1.`);
  }
  const params = copyCreationParams(Object.fromEntries(rows.map(row => [row.key, row.value])));
  const units = Object.fromEntries(rows.filter(row => row.unit !== '').map(row => [row.key, row.unit]));
  const bases = Object.fromEntries(rows.filter(row => row.unit === 'p.u.').map(row => [row.key, parameterBaseDraft(row.power ?? '', row.voltage ?? '')]));
  return { params, ...(Object.keys(units).length ? { parameterUnitDeclaration: copyCreationUnits(Object.keys(bases).length ? { formatVersion: 2, units, bases } : { formatVersion: 1, units }, params) } : {}) };
}
