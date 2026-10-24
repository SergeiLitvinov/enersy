import { expect, test } from 'vitest';
import { parseOperatingAssessment,parseTerminalVoltageLimits,requireOperatingLimits } from './operating-assessment';
import { parseCalculationResult } from './ees-api';
const nodes = [{ node_id: 1, voltage: 9 }];
const check = { component_id: 2, terminal: 1, bus_id: 1, quantity: 'line_to_line_rms_voltage', unit: 'kV', min: 9.5, max: 10.5, measured: 9, status: 'below_min' };
const assessment = { schema_version: 1, policy: 'explicit-terminal-voltage-v1', status: 'violated', checks: [check], stability_assessed: false };
test('explicit request limits are immutable, unique and confirmed by result bounds',()=>{
  const limits=[{component_id:2,terminal:1,min_kv:9.5,max_kv:10.5}];
  const captured=parseTerminalVoltageLimits(limits);limits[0].min_kv=1;
  expect(captured[0].min_kv).toBe(9.5);
  const parsed=parseOperatingAssessment(assessment,nodes)!;
  expect(()=>requireOperatingLimits(parsed,captured)).not.toThrow();
  for(const raw of [null,[captured[0],captured[0]],[{...captured[0],max_kv:8}],[{...captured[0],unit:'kV'}]])expect(()=>parseTerminalVoltageLimits(raw)).toThrow();
  expect(()=>requireOperatingLimits(undefined,captured)).toThrow('не подтвердил');
  expect(()=>requireOperatingLimits(parsed,limits)).toThrow('не подтвердил');
  expect(()=>requireOperatingLimits(parsed)).toThrow('незаданные');
});
test('absence, undeclared constraints and assessed bounds have distinct meanings', () => {
  expect(parseOperatingAssessment(undefined,nodes)).toBeUndefined();
  expect(parseOperatingAssessment({ ...assessment, status: 'not_declared', checks: [] },nodes)?.status).toBe('not_declared');
  expect(parseOperatingAssessment(assessment,nodes)?.status).toBe('violated');
  expect(parseOperatingAssessment({ ...assessment,status: 'within_declared_bounds',checks: [{...check,min:9,max:9,status:'within_bounds'}] },nodes)?.status).toBe('within_declared_bounds');
});
test('rejects forged passes, quantities, duplicate checks and unrelated result nodes', () => {
  for (const invalid of [null, { ...assessment, status:'within_declared_bounds' }, { ...assessment,stability_assessed:true },
    ...[{status:'within_bounds'}, {measured:10}, {bus_id:2}, {unit:'V'}, {quantity:'phase_voltage'}, {min:0}, {max:8}].map(change => ({...assessment,checks:[{...check,...change}]})),
    {...assessment,checks:[check,check]}]) expect(() => parseOperatingAssessment(invalid,nodes)).toThrow();
  const topology = { schema_version:1 as const,node_numbering:'min-component-terminal' as const,internal_nodes:[],
    terminals:[{component_id:2,component_type:'load',terminal:1,bus_id:2,omitted_reason:null}] };
  expect(() => parseOperatingAssessment(assessment,nodes,topology)).toThrow();
});
test('result parser validates assessment before an immediate or archived result can render', () => {
  const result = {success:true,node_count:1,iterations:1,computation_time_ms:1,method_used:'test',
    nodes:[{...nodes[0],node_type:'pq',angle:0,phase:9,quadrature:0}],operating_assessment:assessment};
  expect(parseCalculationResult(result).operating_assessment?.status).toBe('violated');
  expect(() => parseCalculationResult({...result,operating_assessment:{...assessment,status:'within_declared_bounds'}})).toThrow();
});
