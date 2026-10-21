import type { ComponentParam, EquipmentModel } from './ees-api';

function code(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error('Некорректный тип оборудования');
  return value;
}
async function read(path: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await fetch(path, { signal, cache: 'no-store', credentials: 'same-origin' });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error('Не удалось прочитать каталог оборудования');
  const value: unknown = await response.json(); signal?.throwIfAborted();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректная карточка каталога');
  return value as Record<string, unknown>;
}
export async function readEquipmentModels(type: string, signal?: AbortSignal): Promise<EquipmentModel[]> {
  const value = await read(`/api/ees/equipment-models/${code(type)}`, signal);
  if (!Array.isArray(value)) throw new Error('Некорректный список паспортов');
  const seen = new Set<number>();
  return value.map(raw => {
    const item = record(raw);
    if (typeof item.id !== 'number' || !Number.isInteger(item.id) || item.id <= 0 || item.id > 2147483647 || seen.has(item.id) ||
        typeof item.model_name !== 'string' || !item.model_name.trim() || typeof item.manufacturer !== 'string' || typeof item.description !== 'string') throw new Error('Некорректная карточка паспорта');
    seen.add(item.id);
    return { id: item.id, model_name: item.model_name, manufacturer: item.manufacturer, description: item.description };
  });
}
export async function readEquipmentModelParams(id: number, signal?: AbortSignal): Promise<Record<string, string>> {
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new Error('Некорректный ID паспорта');
  const item = record(await read(`/api/ees/equipment-model/${id}`, signal));
  return Object.fromEntries(Object.entries(item).map(([key, value]) => {
    if (typeof value !== 'string') throw new Error('Некорректное значение паспортного параметра');
    return [key, value];
  }));
}
export async function readParameterTemplate(type: string, signal?: AbortSignal): Promise<ComponentParam[]> {
  const value = await read(`/api/ees/component-params/${code(type)}`, signal);
  if (!Array.isArray(value)) throw new Error('Некорректный шаблон параметров');
  const seen = new Set<string>();
  return value.map(raw => {
    const p = record(raw);
    if (typeof p.key !== 'string' || !p.key || seen.has(p.key) || typeof p.name !== 'string' || typeof p.type !== 'string' ||
        typeof p.default !== 'string' || typeof p.unit !== 'string') throw new Error('Некорректный шаблон параметров');
    seen.add(p.key);
    return { key: p.key, name: p.name, type: p.type, default: p.default, unit: p.unit };
  });
}
