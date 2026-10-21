// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ResultSources } from './ResultSources';
import type { CalculationSource } from '../../../api/ees-api';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const source: CalculationSource = { component_id: 7, type: 'pq', internal_bus: 3, terminal_bus: 1,
  p_mw: 10.1, q_mvar: -2.5, terminal_p_mw: 10, terminal_q_mvar: -3, losses_p_mw: 0.1, losses_q_mvar: 0.5,
  q_limits_applied: true, q_limit_status: 'clamped', q_min_emf_mvar: -2.5, q_max_emf_mvar: 5 };

test('distinguishes source EMF, terminal injection and series losses while retaining EMF Q limits', async () => {
  await act(async () => root.render(<ResultSources sources={[source]} islandByBus={new Map([[3, 2]])} showIslands />));
  expect(host.textContent).toContain('Остров 2');
  const cells = [...host.querySelectorAll('tbody td')].map(cell => cell.textContent);
  expect(cells.slice(2, 8)).toEqual(['10,1', '-2,5', '10', '-3', '0,1', '0,5']);
  expect(cells[8]).toBe('-2,5 … 5'); expect(cells[9]).toBe('На границе');
  expect(host.textContent).toContain('терминальные ограничения пока не поддержаны');
});

test('old archived results retain missing fields rather than fabricated zeros', async () => {
  const legacy = { ...source, terminal_p_mw: undefined, terminal_q_mvar: undefined, losses_p_mw: undefined, losses_q_mvar: undefined };
  await act(async () => root.render(<ResultSources sources={[legacy]} islandByBus={new Map()} showIslands={false} />));
  expect([...host.querySelectorAll('tbody td')].slice(4, 8).map(cell => cell.textContent)).toEqual(Array(4).fill('Не передано'));
  await act(async () => root.render(<ResultSources islandByBus={new Map()} showIslands={false} />));
  expect(host.querySelector('table')).toBeNull();
});
