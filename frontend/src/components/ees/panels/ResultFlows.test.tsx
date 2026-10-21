// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ResultFlows } from './ResultFlows';
import type { CalculationBranch, CalculationShunt } from '../../../api/calculation-flows';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const branch: CalculationBranch = { component_id: 1, code: 'generator', from_bus: 3, to_bus: 1, ratio: 1,
  p_from_mw: 10.1, p_to_mw: -10, q_from_mvar: -1, q_to_mvar: -2, losses_p_mw: 0.1, losses_q_mvar: -3, i_from_ka: 0.6, i_to_ka: 0.6 };
const shunt: CalculationShunt = { component_id: 5, code: 'capacitor', bus: 2, q_nom_mvar: 2, p_mw: 0, q_mvar: -1.9 };
test('renders signed flows and physical units with distinct source and shunt meanings', async () => {
  await act(async () => root.render(<ResultFlows branches={[branch]} shunts={[shunt]} />));
  expect(host.textContent).toContain('Источник · внутреннее сопротивление'); expect(host.textContent).toContain('3 → 1');
  expect(host.textContent).toContain('ΔQ, Мвар'); expect(host.textContent).toContain('I нач., кА');
  expect(host.textContent).toContain('Отрицательная ΔQ допустима');
  expect(host.querySelectorAll('tbody tr')[1].textContent).toContain('-1,9');
});
test('distinguishes missing data from an explicitly empty collection', async () => {
  await act(async () => root.render(<ResultFlows />)); expect(host.textContent).toContain('не предоставил потоки'); expect(host.querySelector('table')).toBeNull();
  await act(async () => root.render(<ResultFlows branches={[]} shunts={[]} />));
  expect(host.textContent).toContain('нет последовательных ветвей'); expect(host.textContent).toContain('нет шунтов оборудования');
});

test('shows a saved transformer shift and distinguishes an archive without shift metadata', async () => {
  await act(async () => root.render(<ResultFlows branches={[{...branch,code:'transformer',phase_shift_deg:-30}]} />));
  expect(host.textContent).toContain('φ НН−ВН: -30°');
  await act(async () => root.render(<ResultFlows branches={[{...branch,code:'transformer'}]} />));
  expect(host.textContent).toContain('φ НН−ВН: Не передано');
});
test('pages large branch and shunt collections independently and bounds a replaced result', async () => {
  const branches = Array.from({ length: 101 }, (_, i) => ({ ...branch, component_id: i + 1 }));
  const shunts = Array.from({ length: 51 }, (_, i) => ({ ...shunt, component_id: i + 200 }));
  await act(async () => root.render(<ResultFlows branches={branches} shunts={shunts} />));
  expect(host.querySelectorAll('tbody tr')).toHaveLength(100);
  const next = host.querySelector<HTMLButtonElement>('[aria-label="Следующая страница потоков"]')!;
  const shuntNext = host.querySelector<HTMLButtonElement>('[aria-label="Следующая страница шунтов"]')!;
  await act(async () => { next.click(); shuntNext.click(); });
  expect(host.querySelectorAll('tbody tr')).toHaveLength(51);
  await act(async () => next.click()); expect(next.disabled).toBe(true);
  expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
  await act(async () => root.render(<ResultFlows branches={[branch]} shunts={[shunt]} />));
  expect(host.querySelectorAll('tbody tr')).toHaveLength(2); expect(host.querySelector('[role="status"]')).toBeNull();
});
