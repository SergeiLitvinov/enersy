import type { CalculationTopology } from './calculation-topology';

export interface TerminalVoltageLimit { component_id: number; terminal: number; min_kv: number; max_kv: number }

export interface VoltageLimitCheck {
  component_id: number; terminal: number; bus_id: number;
  quantity: 'line_to_line_rms_voltage'; unit: 'kV';
  min: number; max: number; measured: number;
  status: 'below_min' | 'above_max' | 'within_bounds';
}
export interface OperatingAssessment {
  schema_version: 1; policy: 'explicit-terminal-voltage-v1';
  status: 'not_declared' | 'violated' | 'within_declared_bounds';
  checks: VoltageLimitCheck[]; stability_assessed: false;
}
const fail = (): never => { throw new Error('Некорректная оценка режимных ограничений'); };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positiveId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export function parseTerminalVoltageLimits(raw: unknown): TerminalVoltageLimit[] {
  if (!Array.isArray(raw) || raw.length > 1000) return fail();
  const seen = new Set<string>();
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const v = value as Record<string,unknown>;
    if (Object.keys(v).length !== 4 || !positiveId(v.component_id) || v.component_id > 2147483647 || !positiveId(v.terminal) || v.terminal > 2147483647 ||
        !finite(v.min_kv) || !finite(v.max_kv) || v.min_kv <= 0 || v.max_kv < v.min_kv) return fail();
    const key = `${v.component_id}/${v.terminal}`;
    if (seen.has(key)) return fail();
    seen.add(key);
    return {component_id:v.component_id,terminal:v.terminal,min_kv:v.min_kv,max_kv:v.max_kv};
  });
}

/** Bind both immediate and archived assessments to the exact requested limits. */
export function requireOperatingLimits(assessment: OperatingAssessment | undefined, limits?: readonly TerminalVoltageLimit[]): void {
  if (limits === undefined) {
    if (assessment?.checks.length) throw new Error('Результат содержит незаданные ограничения');
    return;
  }
  if (!assessment || assessment.checks.length !== limits.length) throw new Error('Сервис не подтвердил заданные ограничения');
  const checks = new Map(assessment.checks.map(c => [`${c.component_id}/${c.terminal}`,c]));
  for (const limit of limits) {
    const check = checks.get(`${limit.component_id}/${limit.terminal}`);
    if (!check || check.min !== limit.min_kv || check.max !== limit.max_kv) throw new Error('Сервис не подтвердил заданные ограничения');
  }
}

/** Absence is historical data, never an implicit pass. Validate summaries against
 * individual checks and the actual node/terminal mapping before rendering. */
export function parseOperatingAssessment(raw: unknown, nodes: readonly { node_id: number; voltage: number }[], topology?: CalculationTopology): OperatingAssessment | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== 1 || value.policy !== 'explicit-terminal-voltage-v1' || value.stability_assessed !== false || !Array.isArray(value.checks)) return fail();
  const voltages = new Map(value.checks.length ? nodes.map(n => [n.node_id,n.voltage]) : []);
  const bindings = value.checks.length && topology ? new Map(topology.terminals.map(t => [`${t.component_id}/${t.terminal}`,t.bus_id])) : undefined;
  const seen = new Set<string>();
  let violated = false;
  for (const rawCheck of value.checks) {
    if (!rawCheck || typeof rawCheck !== 'object' || Array.isArray(rawCheck)) return fail();
    const c = rawCheck as Record<string, unknown>;
    if (!positiveId(c.component_id) || !positiveId(c.terminal) || !positiveId(c.bus_id) ||
        c.quantity !== 'line_to_line_rms_voltage' || c.unit !== 'kV' || !finite(c.min) || !finite(c.max) ||
        c.min <= 0 || c.max < c.min || !finite(c.measured) || c.measured !== voltages.get(c.bus_id)) return fail();
    const key = `${c.component_id}/${c.terminal}`;
    if (seen.has(key) || (bindings && bindings.get(key) !== c.bus_id)) return fail();
    seen.add(key);
    const expected = c.measured < c.min ? 'below_min' : c.measured > c.max ? 'above_max' : 'within_bounds';
    if (c.status !== expected) return fail();
    violated ||= expected !== 'within_bounds';
  }
  const expectedStatus = !value.checks.length ? 'not_declared' : violated ? 'violated' : 'within_declared_bounds';
  if (value.status !== expectedStatus) return fail();
  return value as unknown as OperatingAssessment;
}
