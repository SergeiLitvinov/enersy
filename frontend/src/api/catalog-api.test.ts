import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEquipmentModels, readEquipmentModelParams, readParameterTemplate } from './catalog-api';
afterEach(() => vi.unstubAllGlobals());
function respond(value: unknown) { const fetcher = vi.fn(async () => new Response(JSON.stringify(value))); vi.stubGlobal('fetch', fetcher); return fetcher; }
describe('catalog response boundaries', () => {
  it('rejects malformed or duplicated catalog entries', async () => {
    const item = { id: 1, model_name: 'Model', manufacturer: '', description: '' };
    respond([item, item]); await expect(readEquipmentModels('generator')).rejects.toThrow();
    respond([{ ...item, id: '1' }]); await expect(readEquipmentModels('generator')).rejects.toThrow();
    respond(null); await expect(readEquipmentModels('generator')).rejects.toThrow();
  });
  it('validates identifiers before requesting, and propagates cancellation', async () => {
    const fetcher = respond([]);
    await expect(readEquipmentModels('../private')).rejects.toThrow(); await expect(readEquipmentModelParams(-1)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(readEquipmentModels('generator', controller.signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const active = new AbortController(); await readEquipmentModels('generator', active.signal);
    expect(fetcher).toHaveBeenCalledWith('/api/ees/equipment-models/generator', expect.objectContaining({ signal: active.signal, cache: 'no-store' }));
  });
  it('retains string values including empty, zero and unknown keys', async () => {
    respond({ p: '0', extra: '' }); expect(await readEquipmentModelParams(1)).toEqual({ p: '0', extra: '' });
    respond({ p: 0 }); await expect(readEquipmentModelParams(1)).rejects.toThrow();
    respond([]); await expect(readEquipmentModelParams(1)).rejects.toThrow();
  });
  it('rejects duplicate template keys rather than assigning ambiguous units', async () => {
    const param = { key: 'p', name: 'Power', type: 'number', default: '', unit: 'MW' };
    respond([param, param]); await expect(readParameterTemplate('generator')).rejects.toThrow();
    respond([param]); expect(await readParameterTemplate('generator')).toEqual([param]);
  });
});
