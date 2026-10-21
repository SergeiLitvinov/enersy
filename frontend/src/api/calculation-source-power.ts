import type { CalculationSource } from './ees-api';
import type { CalculationBranch } from './calculation-flows';

const keys = ['terminal_p_mw', 'terminal_q_mvar', 'losses_p_mw', 'losses_q_mvar'] as const;
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) &&
  Math.abs(a - b) <= 1e-7 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
const fail = (): never => { throw new Error('Сервис вернул некорректные мощности на выводах источника'); };

/** New reports must agree with the actual source impedance flow. Legacy
 * absence is retained; no terminal power is synthesized from today's model.
 */
export function validateSourceTerminalPowers(sources: readonly CalculationSource[] | undefined, branches: readonly CalculationBranch[] | undefined): void {
  if (!sources) return;
  const byId = new Map(branches?.filter(b => b.code === 'generator').map(b => [b.component_id, b]));
  for (const source of sources) {
    if (!keys.some(key => source[key] !== undefined)) continue;
    if (!keys.every(key => typeof source[key] === 'number' && Number.isFinite(source[key]))) return fail();
    const branch = byId.get(source.component_id);
    const p = source.terminal_p_mw!, q = source.terminal_q_mvar!;
    if (!branch || !close(p, -branch.p_to_mw) || !close(q, -branch.q_to_mvar) ||
        !close(source.losses_p_mw!, branch.losses_p_mw) || !close(source.losses_q_mvar!, branch.losses_q_mvar) ||
        !close(source.p_mw, p + source.losses_p_mw!) || !close(source.q_mvar, q + source.losses_q_mvar!)) return fail();
  }
}
