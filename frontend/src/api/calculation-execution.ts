export const isCalculationBudget = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 20000;
export interface CalculationExecution {
  policy: 'cooperative-checkpoints-v1'; max_time_ms: number | null;
  native_calls_interruptible: false; disconnect_cancels: false;
}
export function parseCalculationExecution(solver: unknown): CalculationExecution | undefined {
  if (solver === undefined) return undefined;
  if (!solver || typeof solver !== 'object' || Array.isArray(solver)) throw new Error('Некорректные сведения об исполнении расчёта');
  const value = (solver as Record<string, unknown>).execution;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные сведения об исполнении расчёта');
  const e = value as Record<string, unknown>;
  if (e.policy !== 'cooperative-checkpoints-v1' || (e.max_time_ms !== null && !isCalculationBudget(e.max_time_ms)) ||
      e.native_calls_interruptible !== false || e.disconnect_cancels !== false) throw new Error('Некорректные сведения об исполнении расчёта');
  return value as CalculationExecution;
}
export function requireExecutionBudget(solver: unknown, expected?: number): void {
  const execution = parseCalculationExecution(solver);
  if (expected !== undefined && execution?.max_time_ms !== expected) throw new Error('Сервис не подтвердил выбранный бюджет времени');
}
