import { expect, test } from 'vitest';
import { isCalculationBudget, parseCalculationExecution, requireExecutionBudget } from './calculation-execution';
const execution = { policy: 'cooperative-checkpoints-v1', max_time_ms: 20000, native_calls_interruptible: false, disconnect_cancels: false };
test('execution metadata is optional for history and explicit about cooperative limits', () => {
  expect(parseCalculationExecution(undefined)).toBeUndefined();
  expect(parseCalculationExecution({ equations: 4 })).toBeUndefined();
  expect(parseCalculationExecution({ execution })).toEqual(execution);
  expect(parseCalculationExecution({ execution: { ...execution, max_time_ms: null } })?.max_time_ms).toBeNull();
  for (const patch of [{ policy: 'unknown' }, { max_time_ms: 0 }, { max_time_ms: '1000' }, { max_time_ms: 20001 },
    { native_calls_interruptible: true }, { disconnect_cancels: true }, { max_time_ms: undefined }]) {
    expect(() => parseCalculationExecution({ execution: { ...execution, ...patch } })).toThrow();
  }
});
test('budget must be confirmed by the service and never inferred from settings', () => {
  requireExecutionBudget({ execution }, 20000);
  expect(() => requireExecutionBudget({ execution }, 1000)).toThrow('не подтвердил');
  expect(() => requireExecutionBudget(undefined, 20000)).toThrow('не подтвердил');
  for (const invalid of [0,-1,NaN,Infinity,0.5,20001,'10',true]) expect(isCalculationBudget(invalid)).toBe(false);
});
