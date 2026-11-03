export const AC_INPUT_UNIT_PROFILE = 'legacy-ac-three-phase-rms-v1' as const;
export const SCALED_AC_INPUT_UNIT_PROFILE = 'scaled-ac-three-phase-rms-v2' as const;
export const BASED_AC_INPUT_UNIT_PROFILE = 'based-ac-three-phase-rms-v3' as const;
export interface InputUnitContract { formatVersion: 1; profile: typeof AC_INPUT_UNIT_PROFILE | typeof SCALED_AC_INPUT_UNIT_PROFILE | typeof BASED_AC_INPUT_UNIT_PROFILE }
export function parseInputUnitContract(raw: unknown): InputUnitContract {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректный контракт единиц');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, 'formatVersion') || !Object.prototype.hasOwnProperty.call(value, 'profile') ||
      value.formatVersion !== 1 || (value.profile !== AC_INPUT_UNIT_PROFILE && value.profile !== SCALED_AC_INPUT_UNIT_PROFILE && value.profile !== BASED_AC_INPUT_UNIT_PROFILE)) throw new Error('Неподдержанный контракт единиц');
  return { formatVersion: 1, profile: value.profile };
}

/** UI calculations must not accept a generic success from an older unchecked worker. */
export function requireInputUnitContract(raw: unknown, requested: InputUnitContract = { formatVersion: 1, profile: AC_INPUT_UNIT_PROFILE }, coverage?: { components: number; parameters: number; bases: number }): void {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const confirmation = value?.input_unit_contract;
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) throw new Error('Сервер не подтвердил проверку единиц расчёта');
  const c = confirmation as Record<string, unknown>;
  const fields = ['formatVersion', 'profile', 'validation_scope', 'component_count', 'parameter_count'];
  const based = requested.profile === BASED_AC_INPUT_UNIT_PROFILE;
  if (based) fields.push('basis_count');
  const scope = based ? 'request-declarations-with-parameter-bases' : requested.profile === SCALED_AC_INPUT_UNIT_PROFILE ? 'request-declarations-with-scale-normalization' : 'request-declarations-only';
  if (Object.keys(c).length !== fields.length || fields.some(key => !Object.prototype.hasOwnProperty.call(c, key)) ||
      c.formatVersion !== 1 || c.profile !== requested.profile || c.validation_scope !== scope ||
      !Number.isSafeInteger(c.component_count) || (c.component_count as number) < 0 || !Number.isSafeInteger(c.parameter_count) || (c.parameter_count as number) < 0 ||
      based && (!Number.isSafeInteger(c.basis_count) || (c.basis_count as number) < 0) ||
      coverage && (c.component_count !== coverage.components || c.parameter_count !== coverage.parameters || based && c.basis_count !== coverage.bases)) {
    throw new Error('Сервер не подтвердил проверку единиц расчёта');
  }
}
