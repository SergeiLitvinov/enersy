import type { ComponentPatch, SchemeComponent } from '../../api/ees-api';
import { parseComponentRevision } from '../../api/component-revision';
import type { ComponentDraft } from './component-drafts';
import { sameParameterBase, type ParameterBase } from '../../domain/parameter-base';
import { parameterSourceBase } from '../../api/parameter-unit-declaration';

export interface ComponentComparisonRow {
  key: string;
  label: string;
  base: string | number | boolean | undefined;
  local: string | number | boolean | undefined;
  server: string | number | boolean | undefined;
  units?: { base: string | undefined; local: string | undefined; server: string | undefined };
  unitEdit?: boolean;
  baseEdit?: boolean;
  bases?: { base: ParameterBase | null | undefined; local: ParameterBase | null | undefined; server: ParameterBase | null | undefined };
  status: 'pending' | 'server_changed' | 'already_applied' | 'object_missing' | 'unit_changed';
}

/** Three-way comparison includes only fields explicitly touched by local intents. */
export function compareComponentDraft(draft: ComponentDraft, server?: SchemeComponent): ComponentComparisonRow[] {
  const touched = new Map<string, Omit<ComponentComparisonRow, 'key' | 'status'>>();
  const poseLabels = { x: 'Положение X', y: 'Положение Y', rotation: 'Поворот, °', name: 'Название' };
  const parameter = (params: Record<string, string> | undefined, key: string) => params && Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined;
  for (const intent of draft.intents) {
    if (intent.kind === 'pose') {
      for (const field of ['x', 'y', 'rotation', 'name'] as const) {
        if (Object.prototype.hasOwnProperty.call(intent.values, field)) touched.set(`pose:${field}`, { label: poseLabels[field], base: draft.base[field], local: intent.values[field], server: server?.[field] });
      }
    } else if (intent.kind === 'parameter') {
      const baseUnit = parameter(draft.base.declaredParameterUnits?.units, intent.key);
      const previous = touched.get(`parameter:${intent.key}`);
      const localUnit = intent.unit ?? previous?.units?.local ?? baseUnit;
      const baseBasis = parameterSourceBase(draft.base.declaredParameterUnits, intent.key);
      const serverBasis = parameterSourceBase(server?.declaredParameterUnits, intent.key);
      const baseEdit = Object.prototype.hasOwnProperty.call(intent, 'base');
      const localBasis = localUnit === 'p.u.' ? (baseEdit ? intent.base : previous ? previous.bases?.local : baseBasis) : undefined;
      touched.set(`parameter:${intent.key}`, { label: `Параметр ${intent.key}`, base: parameter(draft.base.params, intent.key), local: intent.value, server: parameter(server?.params, intent.key),
        units: { base: baseUnit, local: localUnit, server: parameter(server?.declaredParameterUnits?.units, intent.key) },
        ...(baseBasis || localBasis || serverBasis ? { bases: { base: baseBasis, local: localBasis, server: serverBasis } } : {}),
        ...(baseEdit || previous?.baseEdit ? { baseEdit: true } : {}),
        ...(intent.unit === undefined && !previous?.unitEdit ? {} : { unitEdit: true }) });
    } else touched.set('delete', { label: 'Объект существует', base: true, local: false, server: Boolean(server) });
  }
  return [...touched].map(([key, row]) => ({ key, ...row, status: !server && key !== 'delete' ? 'object_missing'
    : Object.is(row.local, row.server) && (!row.units || row.units.local === row.units.server) && sameParameterBase(row.bases?.local, row.bases?.server) ? 'already_applied'
    : row.units && (row.units.base !== row.units.server || !sameParameterBase(row.bases?.base, row.bases?.server)) ? 'unit_changed'
    : Object.is(row.base, row.server) ? 'pending' : 'server_changed' }));
}

/** Acceptance validates the same identity and selection without reinterpreting local values. */
export function validateRecoverySelection(draft: ComponentDraft, server: SchemeComponent | undefined, selected: ReadonlySet<string>) {
  if (!server || server.id !== draft.componentId || server.typeId !== draft.base.typeId || server.type !== draft.base.type ||
    (server.equipmentModelId ?? null) !== (draft.base.equipmentModelId ?? null) ||
    (server.projectPassportVersionId ?? null) !== (draft.base.projectPassportVersionId ?? null)) {
    throw new Error('Объект отсутствует или его тип/паспорт изменился. Повторно сравните оборудование.');
  }
  const revision = parseComponentRevision(server.revision);
  const rows = new Map(compareComponentDraft(draft, server).map(row => [row.key, row]));
  if (selected.size === 0) throw new Error('Выберите поля для применения');
  for (const key of selected) {
    if (!rows.has(key) || key === 'delete') throw new Error('Удаление выполняется отдельно от изменения полей');
  }
  return { revision, rows };
}

/** Build a reviewed partial write against exactly the compared server revision. */
export function prepareRecoveryPatch(draft: ComponentDraft, server: SchemeComponent | undefined, selected: ReadonlySet<string>): { revision: string; patch?: ComponentPatch } {
  const { revision, rows } = validateRecoverySelection(draft, server, selected);
  const patch: ComponentPatch = {};
  for (const key of selected) {
    const row = rows.get(key);
    if (!row || key === 'delete') throw new Error('Удаление выполняется отдельно от изменения полей');
    if (row.status === 'unit_changed') throw new Error('Единица или исходный базис параметра изменились. Примите серверное значение и заново задайте параметр в актуальной единице и базисе.');
    if (row.status === 'already_applied') continue;
    if (key.startsWith('parameter:')) {
      if (typeof row.local !== 'string') throw new Error('Некорректное значение параметра');
      patch.params ??= {};
      Object.defineProperty(patch.params, key.slice('parameter:'.length), { value: row.local, enumerable: true, configurable: true, writable: true });
      if (row.unitEdit && row.units?.local !== undefined) {
        patch.parameterUnitDeclaration ??= { formatVersion: 1, units: {} };
        Object.defineProperty(patch.parameterUnitDeclaration.units, key.slice('parameter:'.length), { value: row.units.local, enumerable: true, configurable: true, writable: true });
        if ((row.baseEdit || !sameParameterBase(row.bases?.base, row.bases?.local)) && row.units.local === 'p.u.') {
          patch.parameterUnitDeclaration.formatVersion = 2;
          patch.parameterUnitDeclaration.bases ??= {};
          Object.defineProperty(patch.parameterUnitDeclaration.bases, key.slice('parameter:'.length), { value: row.bases?.local ? { ...row.bases.local } : null, enumerable: true, configurable: true, writable: true });
        }
      }
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
