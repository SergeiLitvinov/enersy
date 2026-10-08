import { afterEach, expect, it, vi } from 'vitest';
import { addComponent, addConnection, newConnectionCommandId, deleteConnection, calculateScheme, calculationErrorMessage, getComputeCapabilities, parseCalculationResult } from './ees-api';

afterEach(() => { vi.unstubAllGlobals(); });

it('retains an explicit command key and payload when a connection request is repeated', async () => {
  const first = newConnectionCommandId(), second = newConnectionCommandId();
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first).not.toBe(second);
  const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, id: 4, commandId: first }) });
  vi.stubGlobal('fetch', request);
  await addConnection(1, 2, 3, 'left', 'right', first);
  await addConnection(1, 2, 3, 'left', 'right', first);
  expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  expect(request.mock.calls[0][1].headers['Idempotency-Key']).toBe(first);
  expect(request.mock.calls[0][0]).toBe('/api/ees/connection-commands');
});

it('never falls back to legacy creation when the protected route is unavailable', async () => {
  const request = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
  vi.stubGlobal('fetch', request);
  await expect(addConnection(1, 2, 3, 'left', 'right', '11111111-1111-4111-8111-111111111111')).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][0]).toBe('/api/ees/connection-commands');
});

it('does not confirm a keyed command with a legacy or unrelated acknowledgement', async () => {
  const commandId = '11111111-1111-4111-8111-111111111111';
  for (const returned of [undefined, '22222222-2222-4222-8222-222222222222']) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, id: 4, commandId: returned }) }));
    await expect(addConnection(1, 2, 3, 'left', 'right', commandId)).rejects.toThrow('идентичность');
  }
});

it('requires explicit connection creation and deletion acknowledgements even for HTTP 200', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  for (const reply of [null, {}, { success: false, id: 1 }, { success: true, id: 0 }, { success: true, id: '1' }, { success: true, id: 1.5 }]) {
    request.mockResolvedValue({ ok: true, json: async () => reply });
    await expect(addConnection(1, 2, 3, 'left', 'right')).rejects.toThrow('не подтверждено');
  }
  request.mockResolvedValue({ ok: true, json: async () => ({ success: true, id: 4 }) });
  expect(await addConnection(1, 2, 3, 'left', 'right')).toEqual({ success: true, id: 4 });
  for (const reply of [null, {}, { success: false }]) {
    request.mockResolvedValue({ ok: true, json: async () => reply });
    await expect(deleteConnection(4)).rejects.toThrow('не подтверждено');
  }
  request.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  expect(await deleteConnection(4)).toEqual({ success: true });
});

it('validates complete island partitions and independent slack references', () => {
  const nodes = [1, 2].map(id => ({ node_id: id, node_type: 'slack', island: id, voltage: 110, angle: id * 15, phase: 100, quadrature: 20 }));
  const island_results = [1, 2].map(id => ({ island_id: id, bus_ids: [id], slack_bus: id, slack_component: id + 10,
    iterations: 1, max_mismatch_pu: 1e-12, computation_time_ms: 2, balance: { residual_p_mw: 0, residual_q_mvar: 0 } }));
  const result = { success: true, nodes, node_count: 2, iterations: 2, computation_time_ms: 4, method_used: 'newton-raphson', island_results };
  expect(parseCalculationResult(result)).toEqual(result);
  for (const patch of [{ bus_ids: [1] }, { bus_ids: [2, 99] }, { slack_bus: 1 }, { island_id: 1 },
    { iterations: 2 }, { max_mismatch_pu: NaN }, { balance: { residual_p_mw: 0, residual_q_mvar: Infinity } }]) {
    expect(() => parseCalculationResult({ ...result, island_results: [island_results[0], { ...island_results[1], ...patch }] })).toThrow('некорректный');
  }
  expect(() => parseCalculationResult({ ...result, island_results: [island_results[0]] })).toThrow('некорректный');
  expect(() => parseCalculationResult({ ...result, nodes: [nodes[0], { ...nodes[1], island: 1 }] })).toThrow('некорректный');
});

const sourceResult = { success: true, nodes: [1, 2].map(node_id => ({ node_id, node_type: 'pq', voltage: 10, angle: 0, phase: 10, quadrature: 0 })), node_count: 2, iterations: 2, computation_time_ms: 3, method_used: 'newton-raphson' };
const limitedSource = { component_id: 7, type: 'pq', internal_bus: 1, terminal_bus: 2, p_mw: 10, q_mvar: -5,
  q_limits_applied: true, q_limit_status: 'clamped', q_min_emf_mvar: -20, q_max_emf_mvar: -5 };

it('accepts limited source results and legacy sources without invented bounds', () => {
  const current = { ...sourceResult, sources: [limitedSource] };
  expect(parseCalculationResult(current)).toEqual(current);
  const legacy = { component_id: 8, type: 'slack', internal_bus: 1, terminal_bus: 2, p_mw: 11, q_mvar: 3, q_limits_applied: false };
  expect(parseCalculationResult({ ...sourceResult, sources: [legacy] }).sources).toEqual([legacy]);
});

it('rejects nonfinite, duplicated and contradictory source reports', () => {
  for (const fields of [{ q_mvar: NaN }, { p_mw: Infinity }, { component_id: 0 }, { type: 'pv' },
    { q_min_emf_mvar: 0 }, { q_max_emf_mvar: undefined }, { q_limit_status: 'unknown' },
    { q_limits_applied: false }, { terminal_bus: 1.5 }, { terminal_bus: 99 }, { internal_bus: 2 }]) {
    expect(() => parseCalculationResult({ ...sourceResult, sources: [{ ...limitedSource, ...fields }] })).toThrow('некорректный');
  }
  expect(() => parseCalculationResult({ ...sourceResult, sources: [limitedSource, limitedSource] })).toThrow('некорректный');
  expect(() => parseCalculationResult({ ...sourceResult, nodes: [sourceResult.nodes[0], sourceResult.nodes[0]] })).toThrow('некорректный');
});

it('preserves the server reason when a connection is rejected', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Оба объекта должны принадлежать выбранной схеме' }) }));
  await expect(addConnection(1, 7, 8, 'top', 'bottom')).rejects.toThrow('принадлежать выбранной схеме');
});

it('creates a passport snapshot in one request and keeps server diagnostics', async () => {
  const created = { id: 7, revision: '2', success: true, params: { voltage_nom: '10' }, equipmentModelId: 3 };
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
