// @vitest-environment jsdom
import React,{act,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,test} from 'vitest';
import {useConnectionGeometry} from './useConnectionGeometry';
import type {EditorComponent,EditorConnection} from '../editor-utils';

test('committed React renders reuse unaffected routes and a new editor scope rebuilds them',async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const components:EditorComponent[]=Array.from({length:3},(_,i)=>({id:i+1,type:'transmission_line',typeId:1,revision:'1',name:'Line',x:i*300,y:0,rotation:0,params:{}}));
  const connections:EditorConnection[]=[{id:1,from:1,to:2,fromPort:'right',toPort:'left'},{id:2,from:2,to:3,fromPort:'right',toPort:'left'}];
  let paths:ReturnType<typeof useConnectionGeometry>;
  function Harness({items=components,scope='A'}:{items?:EditorComponent[];scope?:string}){paths=useConnectionGeometry(items,connections,scope);return null;}
  const root=createRoot(document.createElement('div'));
  try{
    await act(async()=>root.render(<StrictMode><Harness/></StrictMode>));
    const first=paths!;
    await act(async()=>root.render(<StrictMode><Harness items={components.map(c=>({...c,params:{r0:'1'}}))}/></StrictMode>));
    expect(paths!.get(1)).toBe(first.get(1));
    await act(async()=>root.render(<StrictMode><Harness items={components.map(c=>c.id===1?{...c,y:100}:c)}/></StrictMode>));
    expect(paths!.get(1)).not.toBe(first.get(1));expect(paths!.get(2)).toBe(first.get(2));
    await act(async()=>root.render(<StrictMode><Harness scope="B"/></StrictMode>));
    expect(paths!.get(2)).not.toBe(first.get(2));
    await act(async()=>root.render(<StrictMode><Harness scope="A"/></StrictMode>));
    expect(paths!.get(2)).not.toBe(first.get(2));
  }finally{await act(async()=>root.unmount());}
});
