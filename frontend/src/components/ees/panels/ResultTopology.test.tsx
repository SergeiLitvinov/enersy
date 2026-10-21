// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ResultTopology } from './ResultTopology';
import type { CalculationTopology } from '../../../api/calculation-topology';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const fixture = (count: number): CalculationTopology => ({ schema_version: 1, node_numbering: 'min-component-terminal',
  terminals: Array.from({ length: count }, (_, i) => ({ component_id: i + 1, component_type: 'load', terminal: 1, bus_id: i + 1, omitted_reason: null })),
  internal_nodes: [{ component_id: 99, bus_id: 100, role: 'source_emf' }] });

test('large maps render at most 50 rows and support bounded page navigation', async () => {
  await act(async () => root.render(<ResultTopology topology={fixture(100)} />));
  const next = host.querySelector<HTMLButtonElement>('[aria-label="Следующая страница карты узлов"]')!;
  const back = host.querySelector<HTMLButtonElement>('[aria-label="Предыдущая страница карты узлов"]')!;
  expect(host.querySelectorAll('tbody tr')).toHaveLength(50); expect(back.disabled).toBe(true);
  await act(async () => next.click()); expect(host.querySelector('[role="status"]')?.textContent).toBe('51–100 из 101');
  await act(async () => next.click()); expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(host.textContent).toContain('Внутренняя ЭДС'); expect(next.disabled).toBe(true);
  await act(async () => back.click()); expect(host.querySelectorAll('tbody tr')).toHaveLength(50);
  await act(async () => root.render(<ResultTopology topology={fixture(1)} />));
  expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
});

test('omitted terminals have no invented bus and legacy results state the missing map', async () => {
  const value = fixture(1); value.terminals.push({ component_id: 2, component_type: 'breaker', terminal: 1, bus_id: null, omitted_reason: 'unused_switch' });
  await act(async () => root.render(<ResultTopology topology={value} />));
  expect(host.querySelectorAll('tbody tr')[1].textContent).toContain('—Аппарат без связей · исключён');
  await act(async () => root.render(<ResultTopology />));
  expect(host.querySelector('table')).toBeNull(); expect(host.textContent).toContain('не публикует соответствие');
});
