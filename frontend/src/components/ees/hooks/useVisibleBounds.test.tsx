// @vitest-environment jsdom
import React,{act,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,test,vi} from 'vitest';
import {useVisibleBounds} from './useVisibleBounds';

test('viewport bounds follow resize and zoom; cleanup disconnects observation',async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  let measure:()=>void=()=>{};
  const disconnect=vi.fn();
  vi.stubGlobal('ResizeObserver',class {
    constructor(callback:()=>void){measure=callback;}
    observe(){}
    disconnect=disconnect;
  });
  let width=800,height=100;
  const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>({width,height} as DOMRect));
  let bounds:ReturnType<typeof useVisibleBounds>;
  function Harness({size=100}:{size?:number}){
    const ref=useRef<HTMLDivElement>(null);
    bounds=useVisibleBounds(ref,{x:0,y:0,w:size,h:size});
    return <div ref={ref}/>;
  }
  const root=createRoot(document.createElement('div'));
  try{
    await act(async()=>root.render(<Harness/>));
    expect(bounds!).toEqual({left:-382,right:482,top:-32,bottom:132});
    width=200;height=200;
    await act(async()=>measure());
    expect(bounds!).toEqual({left:-16,right:116,top:-16,bottom:116});
    await act(async()=>root.render(<Harness size={50}/>));
    expect(bounds!).toEqual({left:-8,right:58,top:-8,bottom:58});
    width=0;
    await act(async()=>measure());
    expect(bounds!).toBeNull();
  }finally{
    await act(async()=>root.unmount());
    rect.mockRestore();vi.unstubAllGlobals();
  }
  expect(disconnect).toHaveBeenCalledTimes(1);
});
