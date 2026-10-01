import { afterEach, expect, it, vi } from 'vitest';
import { addComponent, addConnection, calculateScheme, calculationErrorMessage, getComputeCapabilities, parseCalculationResult } from './ees-api';

afterEach(() => { vi.unstubAllGlobals(); });

it('preserves the server reason when a connection is rejected', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Оба объекта должны принадлежать выбранной схеме' }) }));
  await expect(addConnection(1, 7, 8, 'top', 'bottom')).rejects.toThrow('принадлежать выбранной схеме');
});

it('creates a passport snapshot in one request and keeps server diagnostics', async () => {
  const created = { id: 7, success: true, params: { voltage_nom: '10' }, equipmentModelId: 3 };
  const request = vi.fn().mockResolvedValue({ ok: true, json: async () => created });
  vi.stubGlobal('fetch', request);
  expect(await addComponent(1, 2, 10, 20, 0, 'Источник', 3)).toEqual(created);
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ equipmentModelId: 3, params: {} });
  request.mockResolvedValue({ ok: false, json: async () => ({ error: 'Паспортная модель не соответствует типу оборудования' }) });
  await expect(addComponent(1, 2, 0, 0, 0, 'Источник', 3)).rejects.toThrow('не соответствует');
});

it('keeps structured physics errors visible', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { code: 'island', message: 'Остров без источника', detail: 'Узел 12' } }) }));
  await expect(calculateScheme(1)).rejects.toThrow('Остров без источника: Узел 12');
  expect(calculationErrorMessage({ error: 'Service unavailable' })).toBe('Service unavailable');
  expect(calculationErrorMessage({ error: 'Не хватает данных', error_detail: { message: 'Параметр отсутствует', detail: 'load#5.p' } })).toBe('Параметр отсутствует: load#5.p');
});

it('rejects unknown capability states instead of enabling them', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ capabilities: [{ model_group: 'x', method: 'y', status: 'ready', summary: '', reasons: [] }] }) }));
  await expect(getComputeCapabilities()).rejects.toThrow('Некорректная запись');
});

it('accepts explicit experimental status and passes abort signal', async () => {
  const entries = [{ model_group: 'three-phase', method: 'newton-raphson', status: 'experimental', summary: 'AC', reasons: ['IEEE validation pending'] }];
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ capabilities: entries }) });
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  expect(await getComputeCapabilities(controller.signal)).toEqual(entries);
  expect(fetch).toHaveBeenCalledWith('/api/ees/capabilities', { signal: controller.signal });
});

it('rejects malformed and nonfinite numerical results before rendering', () => {
  const result = { success: true, nodes: [{ node_id: 1, node_type: 'pq', voltage: 10, angle: 0, phase: 10, quadrature: 0 }], node_count: 1, iterations: 2, computation_time_ms: 3, method_used: 'newton-raphson' };
  expect(parseCalculationResult(result)).toEqual(result);
  expect(() => parseCalculationResult({ ...result, nodes: [{ ...result.nodes[0], voltage: NaN }] })).toThrow('некорректный');
  expect(() => parseCalculationResult({ ...result, node_count: 2 })).toThrow('некорректный');
  expect(() => parseCalculationResult({ ...result, warnings: [null] })).toThrow('некорректный');
});
