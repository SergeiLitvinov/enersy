export const AC_INPUT_UNIT_PROFILE = 'legacy-ac-three-phase-rms-v1' as const;
export interface InputUnitContract { formatVersion: 1; profile: typeof AC_INPUT_UNIT_PROFILE }
export function parseInputUnitContract(raw: unknown): InputUnitContract {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректный контракт единиц');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, 'formatVersion') || !Object.prototype.hasOwnProperty.call(value, 'profile') ||
      value.formatVersion !== 1 || value.profile !== AC_INPUT_UNIT_PROFILE) throw new Error('Неподдержанный контракт единиц');
  return { formatVersion: 1, profile: AC_INPUT_UNIT_PROFILE };
}
