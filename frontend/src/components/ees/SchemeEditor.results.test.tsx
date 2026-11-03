// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import * as api from '../../api/ees-api';
import { SchemeEditor } from './SchemeEditor';
type EditorData = ReturnType<(typeof import('./hooks/useSchemeData'))['useSchemeData']>;
let data: EditorData;
vi.mock('../../api/ees-api');
const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../NotificationProvider', () => ({ useNotify: () => ({ notify }) }));
vi.mock('./hooks/useComputeBackends', () => ({ useComputeBackends: () => ({ ids: ['julia'], message: '', reload: () => undefined }) }));
vi.mock('./hooks/useSchemeData', async importOriginal => {
  const original = await importOriginal<typeof import('./hooks/useSchemeData')>();
  return { ...original, useSchemeData: (...args: Parameters<typeof original.useSchemeData>) => { data = original.useSchemeData(...args); return data; } };
});
vi.mock('../ui/Dialog', () => ({ Dialog: ({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) =>
  <section role="dialog" aria-label={title}><button onClick={onClose}>Закрыть тестовое окно</button>{children}</section> }));
const component: api.SchemeComponent = { id: 1, typeId: 1, type: 'load', name: 'Load', revision: '1', x: 0, y: 0, rotation: 0, params: { p: '0.1000' } };
const result: api.CalculationResult = { success: true, nodes: [{ node_id: 1, node_type: 'PQ', voltage: 110, angle: 0, phase: 1, quadrature: 0 }],
  node_count: 1, iterations: 2, computation_time_ms: 1, method_used: 'newton-raphson',
  topology: { schema_version: 1, node_numbering: 'min-component-terminal', terminals: [{ component_id: 1, component_type: 'load', terminal: 0, bus_id: 1, omitted_reason: null }], internal_nodes: [] } };
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeEach(async () => {
  vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api.getComponentTypes).mockResolvedValue([]); vi.mocked(api.getComponentParams).mockResolvedValue([]);
  vi.mocked(api.getSchemes).mockResolvedValue([{ id: 1, name: 'Original scheme', description: '', created_at: '', updated_at: '' }]);
  vi.mocked(api.getScheme).mockResolvedValue({ id: 1, name: 'Original scheme', description: '', created_at: '', updated_at: '', components: [component], connections: [] });
  vi.mocked(api.getComputeCapabilities).mockResolvedValue([{ model_group: 'three-phase', method: 'newton-raphson', status: 'experimental', summary: '', reasons: [] }]);
  vi.mocked(api.calculateScheme).mockResolvedValue(result);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<SchemeEditor schemeId={1} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function calculate() { await act(async () => host.querySelector<HTMLButtonElement>('.calculate-button')!.click()); }
const notice = () => host.querySelector('[aria-label="Контекст последнего расчёта"]')!;
async function close() { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Закрыть тестовое окно')!.click()); }

test('completed results retain the original caption and warn after parameter changes', async () => {
  await calculate(); expect(notice().textContent).toContain('Original scheme'); expect(notice().querySelector('[role=alert]')).toBeNull();
  await act(async () => data.setComponents(previous => previous.map(item => ({ ...item, params: { p: '0.2000' } }))));
  expect(notice().querySelector('[role=alert]')!.textContent).toContain('изменились');
  expect(host.querySelector('.results-table')!.textContent).toContain('110');
  await close(); expect(host.textContent).toContain('Предыдущий запрос');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Границы напряжения"]')!.click());
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Добавить границу')!.disabled).toBe(true);
});
test('drawing changes do not mark the physical result stale', async () => {
  await calculate(); await act(async () => data.setComponents(previous => previous.map(item => ({ ...item, x: 100, rotation: 90, revision: '2', name: 'Renamed' }))));
  expect(notice().querySelector('[role=alert]')).toBeNull();
});
test('new calculation settings mark the previous result without replacing its numbers', async () => {
  await calculate(); await close();
  const budget = host.querySelector<HTMLInputElement>('[aria-label="Бюджет времени, мс"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(budget, '5000'); budget.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(host.textContent).toContain('Предыдущий запрос');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Результаты последнего расчёта"]')!.click());
  expect(notice().querySelector('[role=alert]')).not.toBeNull(); expect(api.calculateScheme).toHaveBeenCalledTimes(1);
});

test('physical writes during calculation remain visible even when values return to their original state', async () => {
  let finish!: (value: api.CalculationResult) => void;
  vi.mocked(api.calculateScheme).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(api.setComponentParam).mockResolvedValueOnce({ success: true, revision: '2' }).mockResolvedValueOnce({ success: true, revision: '3' });
  await calculate();
  expect(api.calculateScheme).toHaveBeenCalledTimes(1);
  await act(async () => { await data.saveComponentParam(1, 'p', '0.2000'); });
  await act(async () => { await data.saveComponentParam(1, 'p', '0.1000'); });
  expect(data.components[0].params.p).toBe('0.1000');
  await act(async () => finish(result));
  expect(notice().querySelector('[role=alert]')!.textContent).toContain('Во время запроса');
});
