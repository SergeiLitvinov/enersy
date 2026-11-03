import type { ComponentParam, SchemeComponent, SchemeConnection } from '../../api/ees-api';
import type { TerminalVoltageLimit } from '../../api/operating-assessment';
import { AC_INPUT_UNIT_PROFILE } from '../../api/input-unit-contract';
import type { ParameterUnitDeclaration } from '../../api/parameter-unit-declaration';
import type { ParameterBase } from '../../domain/parameter-base';

type Component = SchemeComponent & { paramTemplate?: readonly ComponentParam[] };
const entries = (value: Readonly<Record<string, string>>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'));
function unitKey(declaration: ParameterUnitDeclaration | undefined) {
  if (!declaration) return null;
  const bases: Record<string, ParameterBase | null> = declaration.bases ?? {};
  return [declaration.formatVersion, entries(declaration.units), Object.entries(bases).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, base]) => [key, base == null ? base : [base.profile, base.s_base_mva, base.v_base_kv]])];
}

/** Local observed data only. This is not the server's immutable input SHA-256. */
export function calculationPhysicalKey(components: readonly Component[], connections: readonly SchemeConnection[], unitProfile: string): string {
  return JSON.stringify([
    [...components].sort((a, b) => a.id - b.id).map(component => [component.id, component.typeId, component.type, component.equipmentModelId ?? null, component.projectPassportVersionId ?? null,
      entries(component.params), unitKey(component.declaredParameterUnits),
      unitProfile === AC_INPUT_UNIT_PROFILE ? (component.paramTemplate ?? []).filter(field => Object.prototype.hasOwnProperty.call(component.params, field.key) &&
        !Object.prototype.hasOwnProperty.call(component.declaredParameterUnits?.units ?? {}, field.key)).sort((a, b) => a.key.localeCompare(b.key, 'en')).map(field => [field.key, field.unit]) : [],
    ]),
    [...connections].sort((a, b) => a.id - b.id).map(connection => [connection.id, connection.from, connection.to, connection.fromPort, connection.toPort]),
  ]);
}

export interface CalculationSelection {
  modelGroup: string; method: string; backend: string; unitProfile: string; maxTimeMs: number;
  limits: readonly TerminalVoltageLimit[];
}
export function calculationSelectionKey(selection: CalculationSelection): string {
  return JSON.stringify([selection.modelGroup, selection.method, selection.backend, selection.unitProfile, selection.maxTimeMs,
    selection.limits.map(limit => [limit.component_id, limit.terminal, limit.min_kv, limit.max_kv]).sort((a, b) => a[0] - b[0] || a[1] - b[1])]);
}
