export interface ParameterBase {
  profile: 'ac-three-phase-rms-v1';
  s_base_mva: number;
  v_base_kv: number;
}

export function parameterBaseDraft(power: string, voltage: string): ParameterBase {
  const decimal = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!decimal.test(power.trim()) || !decimal.test(voltage.trim())) throw new Error('Укажите исходные Sб и Uб положительными числами.');
  return parseParameterBase({ profile: 'ac-three-phase-rms-v1', s_base_mva: Number(power), v_base_kv: Number(voltage) });
}

export function parameterBaseLabel(base: ParameterBase | null | undefined): string {
  return base ? `Sб ${base.s_base_mva} МВА · Uб ${base.v_base_kv} кВ (линейное RMS)` : 'Исходный базис не задан';
}

/** Original coefficient representation: three-phase MVA and line RMS kV. */
export function parseParameterBase(raw: unknown): ParameterBase {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректный исходный базис');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || value.profile !== 'ac-three-phase-rms-v1' ||
      !Object.prototype.hasOwnProperty.call(value, 'profile') ||
      !['s_base_mva', 'v_base_kv'].every(key => Object.prototype.hasOwnProperty.call(value, key) &&
        typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] > 0)) {
    throw new Error('Задайте положительные конечные Sб и Uб исходного базиса');
  }
  return { profile: 'ac-three-phase-rms-v1', s_base_mva: value.s_base_mva as number, v_base_kv: value.v_base_kv as number };
}

export function sameParameterBase(a: ParameterBase | null | undefined, b: ParameterBase | null | undefined): boolean {
  return a == null ? b == null : b != null && a.profile === b.profile && a.s_base_mva === b.s_base_mva && a.v_base_kv === b.v_base_kv;
}
