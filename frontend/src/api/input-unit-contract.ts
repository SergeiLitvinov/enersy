export const AC_INPUT_UNIT_PROFILE = 'legacy-ac-three-phase-rms-v1' as const;
export interface InputUnitContract { formatVersion: 1; profile: typeof AC_INPUT_UNIT_PROFILE }
export function parseInputUnitContract(raw: unknown): InputUnitContract {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректный контракт единиц');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, 'formatVersion') || !Object.prototype.hasOwnProperty.call(value, 'profile') ||
      value.formatVersion !== 1 || value.profile !== AC_INPUT_UNIT_PROFILE) throw new Error('Неподдержанный контракт единиц');
  return { formatVersion: 1, profile: AC_INPUT_UNIT_PROFILE };
}

/** UI calculations must not accept a generic success from an older unchecked worker. */
export function requireInputUnitContract(raw: unknown): void {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const confirmation = value?.input_unit_contract;
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) throw new Error('Сервер не подтвердил проверку единиц расчёта');
  const c = confirmation as Record<string, unknown>;
  const fields = ['formatVersion', 'profile', 'validation_scope', 'component_count', 'parameter_count'];
  if (Object.keys(c).length !== fields.length || fields.some(key => !Object.prototype.hasOwnProperty.call(c, key)) ||
      c.formatVersion !== 1 || c.profile !== AC_INPUT_UNIT_PROFILE || c.validation_scope !== 'request-declarations-only' ||
      !Number.isSafeInteger(c.component_count) || (c.component_count as number) < 0 || !Number.isSafeInteger(c.parameter_count) || (c.parameter_count as number) < 0) {
    throw new Error('Сервер не подтвердил проверку единиц расчёта');
  }
}
