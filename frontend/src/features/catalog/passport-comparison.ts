import type { ComponentParam } from '../../api/ees-api';

/** Display stored values only: template defaults are hints, never passport data. */
export function passportRows(template: readonly ComponentParam[], values: readonly Record<string, string>[]) {
  const metadata = new Map(template.map(p => [p.key, p]));
  const keys = new Set([...metadata.keys(), ...values.flatMap(item => Object.keys(item))]);
  return [...keys].map(key => {
    const cells = values.map(item => Object.prototype.hasOwnProperty.call(item, key) ? item[key] : undefined);
    return { key, name: metadata.get(key)?.name || key, unit: metadata.get(key)?.unit || null,
      values: cells, different: cells.length > 1 && cells.some(value => value !== cells[0]) };
  });
}
