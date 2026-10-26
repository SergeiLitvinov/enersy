// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { ArchiveProvenance } from './ArchiveProvenance';
import type { ComponentProvenance } from '../../api/calculation-provenance';

test('comparison distinguishes equal strings, overrides, absent and extra values without inventing history or units', async () => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const host = document.createElement('div'), root = createRoot(host);
  const source: ComponentProvenance = { id: '1',revision:'2',name:'Источник',source:'project-passport',passport:{versionId:'9007199254740993',revision:1,sha256:'a'.repeat(64),document:{formatVersion:1,componentTypeCode:'generator',name:'Паспорт',manufacturer:'',source:'Пример',license:'Автор',parameters:{ same:{value:'0',unit:'МВт'},changed:{value:'10.00',unit:'МВА'},removed:{value:'3',unit:''} }}} };
  const fetcher = vi.fn(); vi.stubGlobal('fetch',fetcher);
  try {
    await act(async () => root.render(<ArchiveProvenance source={source} params={{same:'0',changed:'12.00',extra:''}} />));
    for (const label of ['Строки значений совпадают','Строки значений различаются','Отсутствует в экземпляре','Дополнено в экземпляре','Пустая строка','9007199254740993']) expect(host.textContent).toContain(label);
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => root.render(<ArchiveProvenance params={{same:'0'}} />));
    expect(host.textContent).toContain('не сохранено');
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

test('equal value strings cannot hide different or missing captured unit labels', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'), root = createRoot(host), fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const source: ComponentProvenance = { id: '1', revision: '2', name: 'Нагрузка', source: 'project-passport', passport: {
    versionId: '8', revision: 1, sha256: 'a'.repeat(64), document: { formatVersion: 1, componentTypeCode: 'load', name: 'Паспорт', manufacturer: '', source: 'Fixture', license: 'MIT', parameters: {
      mismatch: { value: '10', unit: 'МВт' }, alias: { value: '10', unit: 'МВт' }, absent: { value: '10', unit: 'МВт' }, blank: { value: '0', unit: '' }, changed: { value: '10.00', unit: 'МВт' },
    } },
  } };
  const params = { mismatch: '10', alias: '10', absent: '10', blank: '0', changed: '10' };
  const units = { mismatch: 'Вт', alias: 'MW', blank: '', changed: 'МВт' };
  const row = (key: string) => [...host.querySelectorAll('tbody tr')].find(r => r.querySelector('th')?.textContent === key)!;
  try {
    await act(async () => root.render(<ArchiveProvenance source={source} params={params} parameterUnits={units} />));
    expect(row('mismatch').textContent).toContain('Строки значений совпадают');
    expect(row('mismatch').textContent).toContain('Обозначения единиц различаются');
    expect(row('alias').textContent).toContain('Обозначения единиц различаются');
    expect(row('alias').textContent).not.toContain('несовместим');
    expect(row('absent').textContent).toContain('Единица в снимке не сохранена');
    expect(row('blank').textContent).toContain('Пустое обозначение');
    expect(row('blank').textContent).toContain('Обозначения единиц совпадают');
    expect(row('changed').textContent).toContain('Строки значений различаются');
    expect(row('changed').textContent).toContain('Обозначения единиц совпадают');
    expect(host.textContent).not.toContain('Совпадает с паспортом');
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => root.render(<ArchiveProvenance source={source} params={params} />));
    expect(row('mismatch').textContent).toContain('Единица в снимке не сохранена');
    expect(units.mismatch).toBe('Вт');
    expect(params.changed).toBe('10');
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
