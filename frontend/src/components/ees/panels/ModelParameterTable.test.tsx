// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { ModelParameterTable } from './ModelParameterTable';
import type { ModelParameterSpec } from '../../../domain/model-parameters';
test('renders stored values separately from model defaults and reports unlisted keys', async () => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true}); const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const specs: ModelParameterSpec[] = [{key:'q',name:'Reactive power',unit:'Mvar',kind:'number',requirement:'optional',default_value:'0',note:'Model default'}, {key:'p',name:'Power',unit:'MW',kind:'number',requirement:'required',default_value:null,note:'Required'}];
  try {
    await act(async()=>root.render(<ModelParameterTable specs={specs} values={{p:'',extra:'42'}} />));
    expect(host.textContent).toContain('Не задано');expect(host.textContent).toContain('Пустое значение');expect(host.textContent).toContain('При отсутствии в модели: 0');expect(host.textContent).toContain('extra');expect(host.querySelectorAll('input')).toHaveLength(0);
    expect(host.querySelectorAll('.model-parameter-missing')).toHaveLength(1);
    await act(async()=>root.render(<ModelParameterTable specs={specs} values={{p:'100',q:'0'}} />));expect(host.querySelectorAll('.model-parameter-missing')).toHaveLength(0);expect(host.textContent).not.toContain('extra');
  } finally {await act(async()=>root.unmount());host.remove();}
});
