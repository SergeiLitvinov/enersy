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
    for (const label of ['Совпадает с паспортом','Отличается от паспорта','Отсутствует в экземпляре','Дополнено в экземпляре','Пустая строка','9007199254740993']) expect(host.textContent).toContain(label);
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => root.render(<ArchiveProvenance params={{same:'0'}} />));
    expect(host.textContent).toContain('не сохранено');
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
