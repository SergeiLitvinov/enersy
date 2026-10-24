// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {OperatingLimitsDialog} from './OperatingLimitsDialog';
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
const apply=vi.fn(),close=vi.fn();
const targets=[{component_id:2,terminal:1,label:'Нагрузка #2 · терминал 1'}];
const initial=[{component_id:2,terminal:1,min_kv:9,max_kv:11}];
beforeEach(()=>{vi.clearAllMocks();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});HTMLDialogElement.prototype.showModal=vi.fn();HTMLDialogElement.prototype.close=vi.fn();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
test('incomplete, reversed and duplicate limits cannot apply; editing does not mutate captured limits',async()=>{
  await act(async()=>root.render(<OperatingLimitsDialog targets={targets} limits={initial} stale={false} onApply={apply} onClose={close}/>));
  const low=host.querySelector<HTMLInputElement>('[aria-label="Минимум 1, кВ"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(low,'12');low.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(button('Применить к следующему расчёту').disabled).toBe(true);
  expect(initial[0].min_kv).toBe(9);
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(low,'9.5');low.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>button('Применить к следующему расчёту').click());
  expect(apply).toHaveBeenCalledWith([{...initial[0],min_kv:9.5}]);
  await act(async()=>button('Добавить границу').click());
  expect(button('Применить к следующему расчёту').disabled).toBe(true);
});
test('changed physical context requires explicit clearing instead of silently retargeting',async()=>{
  await act(async()=>root.render(<OperatingLimitsDialog targets={[]} limits={initial} stale onApply={apply} onClose={close}/>));
  expect(host.textContent).toContain('Состав или связи схемы изменились');
  expect(button('Применить к следующему расчёту').disabled).toBe(true);
  await act(async()=>button('Очистить').click());
  expect(apply).not.toHaveBeenCalled();
  await act(async()=>button('Применить к следующему расчёту').click());
  expect(apply).toHaveBeenCalledWith([]);
});
