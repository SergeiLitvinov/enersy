// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { ArchiveInputs } from './ArchiveInputs';
import type { ArchiveInput } from '../../api/calculation-archives-api';

test('captured units remain distinct from missing and blank labels, without fetching a catalogue', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'), root = createRoot(host), fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const input: ArchiveInput = { modelGroup: 'three-phase', method: 'newton-raphson', connections: [], components: [
    { id: 1, type: 'load', x: 0, y: 0, rotation: 0, params: { p: '10.0000', q: '3', zip_p_z: '0', unknown: '1', spaces: '1', literal: '2' },
      parameterUnits: { p: 'МВт', q: 'Мвар', zip_p_z: '', spaces: '  ', literal: '<b>MW</b>' } },
    { id: 2, type: 'load', x: 0, y: 0, rotation: 0, params: { p: '0.2000' } },
  ] };
  const row = (key: string) => [...host.querySelectorAll('tbody tr')].find(r => r.querySelector('th')?.textContent === key)!;
  try {
    await act(async () => root.render(<ArchiveInputs input={input} />));
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Объект №1')!.click());
    expect(row('p').textContent).toContain('10.0000');
    expect(row('p').querySelector('.archive-unit-value')?.textContent).toBe('МВт');
    expect(row('zip_p_z').querySelector('.archive-unit-value')?.textContent).toBe('Пустое обозначение');
    expect(row('unknown').querySelector('.archive-unit-value')?.textContent).toBe('Не сохранена');
    expect(row('spaces').querySelector('.archive-unit-value')?.textContent).toBe('"  "');
    expect(row('literal').querySelector('.archive-unit-value')?.textContent).toBe('<b>MW</b>');
    expect(host.querySelector('b')).toBeNull();
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Объект №2')!.click());
    expect(row('p').querySelector('.archive-unit-value')?.textContent).toBe('Не сохранена');
    expect(row('p').textContent).toContain('0.2000');
    expect(fetcher).not.toHaveBeenCalled();
    expect(input.components[0].parameterUnits?.p).toBe('МВт');
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

test('the common Study/archive input viewer supplies captured labels to passport comparison', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'), root = createRoot(host);
  const input: ArchiveInput = { modelGroup: 'three-phase', method: 'newton-raphson', connections: [], components: [
    { id: 1, type: 'load', x: 0, y: 0, rotation: 0, params: { p: '10' }, parameterUnits: { p: 'Вт' } },
  ] };
  const provenance = { formatVersion: 1 as const, components: [{ id: '1', revision: '1', name: 'Нагрузка', source: 'project-passport' as const, passport: {
    versionId: '2', revision: 1, sha256: 'a'.repeat(64), document: { formatVersion: 1 as const, componentTypeCode: 'load', name: 'Паспорт', manufacturer: '', source: 'Fixture', license: 'MIT', parameters: { p: { value: '10', unit: 'МВт' } } },
  } }] };
  try {
    await act(async () => root.render(<ArchiveInputs input={input} provenance={provenance} />));
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Объект №1')!.click());
    const comparison = host.querySelector('[aria-label="Происхождение параметров"]')!;
    expect(comparison.textContent).toContain('Строки значений совпадают');
    expect(comparison.textContent).toContain('Обозначения единиц различаются');
    expect(comparison.textContent).not.toContain('Единица в снимке не сохранена');
  } finally { await act(async () => root.unmount()); }
});
