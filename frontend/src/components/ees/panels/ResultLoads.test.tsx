// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { ResultLoads } from './ResultLoads';

test('distinguishes missing data and paginates actual versus nominal signed demand', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'), root = createRoot(host);
  try {
    await act(async () => root.render(<ResultLoads />));
    expect(host.textContent).toContain('нет отдельных сведений');
    const loads = Array.from({ length: 51 }, (_, k) => ({ component_id: k + 1, bus: 2, profile: 'zip' as const, voltage_kv: 9.4, voltage_nom_kv: 10, p_mw: 9.6, q_mvar: -2.8, p_nom_mw: 10, q_nom_mvar: -3 }));
    await act(async () => root.render(<ResultLoads loads={loads} />));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(host.textContent).toContain('отрицательные — выдача');
    expect(host.querySelector('tbody')!.textContent).toContain('-2,8');
    await act(async () => [...host.querySelectorAll('button')].find(el => el.textContent === 'Далее')!.click());
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.querySelector('tbody')!.textContent).toContain('Нагрузка #51');
    await act(async () => root.render(<ResultLoads loads={loads.slice(0, 1)} />));
    expect(host.querySelector('tbody')!.textContent).toContain('Нагрузка #1');
  } finally { await act(async () => root.unmount()); }
});
