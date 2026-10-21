/** Read-only display of legacy status, using the vocabulary of Julia param_bool.
 * This does not compile topology or make unsupported grounding models usable.
 */
export type SwitchPosition = 'open' | 'closed' | 'unknown' | 'catalog';
export interface SwitchDisplay {
  readonly position: SwitchPosition;
  readonly description: string;
}
export function switchDisplay(
  kind: 'breaker' | 'disconnector' | 'grounding_switch',
  params?: Readonly<Record<string, string>>,
): SwitchDisplay {
  if (params === undefined) return { position: 'catalog', description: 'Условное обозначение; положение экземпляра не задано' };
  if (!Object.prototype.hasOwnProperty.call(params, 'status')) {
    // switch_closed defaults to true only for the supported two-terminal devices.
    if (kind !== 'grounding_switch') return { position: 'closed', description: 'Замкнут: допущение текущего ядра при отсутствии status' };
    return { position: 'unknown', description: 'Положение не задано' };
  }
  const value = params.status.trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'замкнут', 'вкл'].includes(value)) return { position: 'closed', description: 'Замкнут (status)' };
  if (['false', '0', 'no', 'off', 'разомкнут', 'откл'].includes(value)) return { position: 'open', description: 'Разомкнут (status)' };
  return { position: 'unknown', description: 'Некорректное значение status: положение неизвестно' };
}
