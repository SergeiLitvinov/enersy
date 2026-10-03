import type { ComponentPatch, SchemeComponent } from '../../api/ees-api';
import { parseComponentRevision } from '../../api/component-revision';
import type { ComponentDraft } from './component-drafts';

export interface ComponentComparisonRow {
  key: string;
  label: string;
  base: string | number | boolean | undefined;
  local: string | number | boolean | undefined;
  server: string | number | boolean | undefined;
  status: 'pending' | 'server_changed' | 'already_applied' | 'object_missing';
}

/** Three-way comparison includes only fields explicitly touched by local intents. */
export function compareComponentDraft(draft: ComponentDraft, server?: SchemeComponent): ComponentComparisonRow[] {
  const touched = new Map<string, { label: string; base: ComponentComparisonRow['base']; local: ComponentComparisonRow['local']; server: ComponentComparisonRow['server'] }>();
  const poseLabels = { x: 'Положение X', y: 'Положение Y', rotation: 'Поворот, °', name: 'Название' };
  const parameter = (params: Record<string, string> | undefined, key: string) => params && Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined;
  for (const intent of draft.intents) {
    if (intent.kind === 'pose') {
      for (const field of ['x', 'y', 'rotation', 'name'] as const) {
        if (Object.prototype.hasOwnProperty.call(intent.values, field)) touched.set(`pose:${field}`, { label: poseLabels[field], base: draft.base[field], local: intent.values[field], server: server?.[field] });
      }
    } else if (intent.kind === 'parameter') {
      touched.set(`parameter:${intent.key}`, { label: `Параметр ${intent.key}`, base: parameter(draft.base.params, intent.key), local: intent.value, server: parameter(server?.params, intent.key) });
    } else touched.set('delete', { label: 'Объект существует', base: true, local: false, server: Boolean(server) });
  }
  return [...touched].map(([key, row]) => ({ key, ...row, status: !server && key !== 'delete' ? 'object_missing'
    : Object.is(row.local, row.server) ? 'already_applied'
    : Object.is(row.base, row.server) ? 'pending' : 'server_changed' }));
}

/** Build a reviewed partial write against exactly the compared server revision. */
export function prepareRecoveryPatch(draft: ComponentDraft, server: SchemeComponent | undefined, selected: ReadonlySet<string>): { revision: string; patch?: ComponentPatch } {
  if (!server || server.id !== draft.componentId || server.typeId !== draft.base.typeId || server.type !== draft.base.type ||
    (server.equipmentModelId ?? null) !== (draft.base.equipmentModelId ?? null)) {
    throw new Error('Объект отсутствует или его тип/паспорт изменился. Повторно сравните оборудование.');
  }
  const revision = parseComponentRevision(server.revision);
  const rows = new Map(compareComponentDraft(draft, server).map(row => [row.key, row]));
  if (selected.size === 0) throw new Error('Выберите поля для применения');
  const patch: ComponentPatch = {};
  for (const key of selected) {
    const row = rows.get(key);
    if (!row || key === 'delete') throw new Error('Удаление выполняется отдельно от изменения полей');
    if (row.status === 'already_applied') continue;
    if (key.startsWith('parameter:')) {
      if (typeof row.local !== 'string') throw new Error('Некорректное значение параметра');
      patch.params ??= {};
      Object.defineProperty(patch.params, key.slice('parameter:'.length), { value: row.local, enumerable: true, configurable: true, writable: true });
    } else {
      patch.pose ??= {};
      switch (key) {
        case 'pose:x': case 'pose:y': case 'pose:rotation':
          if (typeof row.local !== 'number' || !Number.isFinite(row.local)) throw new Error('Некорректное положение оборудования');
          patch.pose[key.slice('pose:'.length) as 'x' | 'y' | 'rotation'] = row.local;
          break;
        case 'pose:name':
          if (typeof row.local !== 'string') throw new Error('Некорректное название оборудования');
          patch.pose.name = row.local;
          break;
        default: throw new Error('Неизвестное поле оборудования');
      }
    }
  }
  return { revision, patch: patch.pose || patch.params ? patch : undefined };
}
