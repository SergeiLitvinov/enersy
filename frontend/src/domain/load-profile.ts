/** Input contract of the current balanced static AC load, not catalogue defaults. */
export const loadProfileKeys = ['p', 'q', 'voltage_nom', 'zip_enabled', 'zip_p_z', 'zip_p_i', 'zip_p_p', 'zip_q_z', 'zip_q_i', 'zip_q_p'] as const;
export type LoadProfileKey = typeof loadProfileKeys[number];
export type LoadProfileDraft = Record<LoadProfileKey, string>;
export const loadProfileDraft = (params: Readonly<Record<string, string>>): LoadProfileDraft =>
  Object.fromEntries(loadProfileKeys.map(key => [key, params[key] ?? ''])) as LoadProfileDraft;

export function loadProfileMode(flag: string): 'pq' | 'zip' | 'unknown' {
  const value = flag.trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'замкнут', 'вкл'].includes(value)) return 'zip';
  if (['', 'false', '0', 'no', 'off', 'разомкнут', 'откл'].includes(value)) return 'pq';
  return 'unknown';
}

function numeric(raw: string): number | undefined {
  const value = raw.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function loadProfileError(draft: LoadProfileDraft): string | undefined {
  const mode = loadProfileMode(draft.zip_enabled);
  if (mode === 'unknown') return 'Выберите поддержанный профиль нагрузки.';
  if (numeric(draft.p) === undefined) return 'Задайте конечное число для P. Десятичный разделитель — точка.';
  if (draft.q.trim() && numeric(draft.q) === undefined) return 'Q должна быть конечным числом.';
  const voltage = numeric(draft.voltage_nom);
  if ((mode === 'zip' || draft.voltage_nom.trim()) && (voltage === undefined || voltage <= 0)) return 'Задайте положительное номинальное напряжение в кВ.';
  if (mode === 'zip') {
    for (const part of ['p', 'q'] as const) {
      const fractions = (['z', 'i', 'p'] as const).map(term => numeric(draft[`zip_${part}_${term}`]));
      if (fractions.some(value => value === undefined || value < 0 || value > 1)) return `Задайте все три доли ${part.toUpperCase()} в диапазоне от 0 до 1.`;
      if (Math.abs(fractions.reduce<number>((sum, value) => sum + value!, 0) - 1) > 1e-12) return `Сумма долей ${part.toUpperCase()} должна равняться 1 (допуск 10⁻¹²).`;
    }
  }
}

/** One atomic patch also clears inactive fractions, preserving unrelated parameters. */
export function loadProfilePatch(draft: LoadProfileDraft): LoadProfileDraft {
  const error = loadProfileError(draft);
  if (error) throw new Error(error);
  const zip = loadProfileMode(draft.zip_enabled) === 'zip';
  return Object.fromEntries(loadProfileKeys.map(key => [key,
    key === 'zip_enabled' ? String(zip) : key.startsWith('zip_') && !zip ? '' : draft[key],
  ])) as LoadProfileDraft;
}
