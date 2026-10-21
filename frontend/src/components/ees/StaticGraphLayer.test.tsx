// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,test,vi} from 'vitest';
import {StaticComponentLayer,StaticConnectionLayer} from './StaticGraphLayer';
import type {EditorComponent,EditorConnection} from './editor-utils';

test('pointer overlay frames retain unrelated SVG nodes and remove duplicate moving equipment/wires',async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const host=document.createElement('div');const root=createRoot(host);
  const components:EditorComponent[]=[1,2].map(id=>({id,type:'busbar',typeId:1,name:`Bus${id}`,revision:'1',x:0,y:0,rotation:0,params:{}}));
  const connections:EditorConnection[]=[{id:1,from:1,to:2,fromPort:'right',toPort:'left'}];
  const renderComponent=vi.fn((c:EditorComponent)=><rect key={c.id} data-component={c.id}/>);
  const renderWire=vi.fn((c:EditorConnection)=><path key={c.id} data-connection={c.id}/>);
  const draw=(x:number)=><svg><StaticComponentLayer components={components} hiddenId={1} render={renderComponent}/>
    <StaticConnectionLayer connections={connections} hidden={connections} render={renderWire}/>
    <g data-moving="1" transform={`translate(${x},0)`}><rect data-component="1"/></g><path data-connection="1"/></svg>;
  try {
    await act(async()=>root.render(draw(0)));
    const staticNode=host.querySelector('[data-component="2"]');
    for(let x=1;x<=20;x++)await act(async()=>root.render(draw(x)));
    expect(renderComponent).toHaveBeenCalledTimes(1);expect(renderWire).not.toHaveBeenCalled();
    expect(host.querySelector('[data-component="2"]')).toBe(staticNode);
    expect(host.querySelectorAll('[data-component="1"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-connection="1"]')).toHaveLength(1);
    expect(host.querySelector('[data-moving]')?.getAttribute('transform')).toBe('translate(20,0)');
  } finally {await act(async()=>root.unmount());}
});
