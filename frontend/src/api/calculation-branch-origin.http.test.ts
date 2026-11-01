import input from '../../../backend-julia/test/reference/json-wire-v1/json3-worker-input-v1.json?raw';
import { expect, test } from 'vitest';
import { parseCalculationResult } from './ees-api';

const worker = import.meta.env.VITE_BRANCH_ORIGIN_WORKER_URL;

test.skipIf(!worker)('real worker provenance survives the production result boundary', async () => {
  const response = await fetch(`${worker}/calculate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input });
  expect(response.status).toBe(200);
  const raw: unknown = await response.json();
  const result = parseCalculationResult(raw);
  expect(result.success).toBe(true);
  expect(result.topology?.schema_version).toBe(2);
  if (result.topology?.schema_version !== 2) throw new Error('Missing v2 provenance');
  expect(result.topology.branch_origins.length).toBe(result.branches?.length);
  const registryResponse = await fetch(`${worker}/model-definitions`);
  expect(registryResponse.status).toBe(200);
  const registry = await registryResponse.json() as { definitions: { id: string }[] };
  const modelIds = new Set(registry.definitions.map(model => model.id));
  for (const origin of result.topology.branch_origins) expect(modelIds.has(origin.model_id)).toBe(true);
  const broken = structuredClone(result);
  if (broken.topology?.schema_version !== 2) throw new Error('Missing v2 provenance');
  broken.topology.branch_origins[0].to = { kind: 'terminal', terminal: 99 };
  expect(() => parseCalculationResult(broken)).toThrow();
  const missing = structuredClone(result);
  if (missing.topology?.schema_version !== 2) throw new Error('Missing v2 provenance');
  const id = missing.topology.branch_origins.shift()?.component_id;
  missing.branches = missing.branches?.filter(branch => branch.component_id !== id);
  expect(() => parseCalculationResult(missing)).toThrow();
}, 30_000);
