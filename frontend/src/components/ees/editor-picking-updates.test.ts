import {expect,test} from 'vitest';
import {createEditorPicker} from './editor-picking';
import {connectionGeometry,worldPorts} from './editor-geometry';
import {updateConnectionGeometry} from './editor-route-cache';
import type {EditorComponent,EditorConnection} from './editor-utils';

function fixture(count=180){
  const components:EditorComponent[]=Array.from({length:count},(_,i)=>({id:i+1,type:'transmission_line',typeId:1,revision:'1',name:`Line ${i}`,
    x:(i%20)*200,y:Math.floor(i/20)*150,rotation:(i%4)*90,params:{}}));
  const connections:EditorConnection[]=components.slice(1).map((c,i)=>({id:i+1,from:i+1,to:c.id,fromPort:'right',toPort:'left'}));
  return {components,connections};
}

test('incremental picking/culling agree with rebuilding through moves, rotations, deletion and compaction',()=>{
  let {components,connections}=fixture();
  let routes=updateConnectionGeometry(null,components,connections,1);
  let picker=createEditorPicker(components,connections,routes.paths,null,1);
  const original=picker;
  for(let step=0;step<90;step++){
    const id=(step*17)%180+1;
    components=components.map(c=>c.id===id?{...c,x:c.x+53,y:c.y-71,rotation:c.rotation+37,name:`Updated ${step}`}:c);
    if(step===25){components=components.filter(c=>c.id!==7);connections=connections.filter(c=>c.from!==7 && c.to!==7);}
    if(step===45)connections=[...connections,{id:900,from:3,to:8,fromPort:'right',toPort:'left'}];
    routes=updateConnectionGeometry(routes,components,connections,1);
    picker=createEditorPicker(components,connections,routes.paths,picker.snapshot,1);
    const fresh=createEditorPicker(components,connections,connectionGeometry(components,connections));
    const selected=components[(step*11)%components.length];
    const points=[{x:selected.x+50,y:selected.y+20},...worldPorts(selected),{x:step*43,y:step*17}];
    for(const point of points){
      expect(picker.componentAt(point)).toEqual(fresh.componentAt(point));
      expect(picker.portAt(point,14)).toEqual(fresh.portAt(point,14));
      expect(picker.portTargetAt(point,150)).toEqual(fresh.portTargetAt(point,150));
      expect(picker.connectionAt(point,8)).toEqual(fresh.connectionAt(point,8));
    }
    const box={left:selected.x-30,right:selected.x+130,top:selected.y-60,bottom:selected.y+90};
    expect(picker.visibleIn(box,[1],[1])).toEqual(fresh.visibleIn(box,[1],[1]));
  }
  expect(original.portAt({x:0,y:20},0)?.comp.id).toBe(1);
},30000);

test('unchanged geometry reuses indexes but resolves current data and paint order by ID',()=>{
  const {components}=fixture(2);components[1]={...components[0],id:2};
  const old=createEditorPicker(components,[],new Map(),null,'A');
  const updated=components.map(c=>({...c,revision:'2',params:{r0:'999'}})).reverse();
  const next=createEditorPicker(updated,[],new Map(),old.snapshot,'A');
  expect(next.changedComponents).toBe(0);
  expect(next.snapshot.bodies).toBe(old.snapshot.bodies);
  expect(next.snapshot.ports).toBe(old.snapshot.ports);
  expect(next.componentAt({x:50,y:20})).toBe(updated[1]);
  expect(next.portAt({x:0,y:20},0)?.comp).toBe(updated[1]);
  expect(old.componentAt({x:50,y:20})).toBe(components[1]);
  const other=createEditorPicker(updated,[],new Map(),next.snapshot,'B');
  expect(other.snapshot.bodies).not.toBe(next.snapshot.bodies);
  expect(other.changedComponents).toBe(2);
});

test('a local move changes one component and incident wire segments without stale old hits',()=>{
  const {components,connections}=fixture(1000);
  const before=updateConnectionGeometry(null,components,connections,1);
  const old=createEditorPicker(components,connections,before.paths,null,1);
  const moved=components.map(c=>c.id===1?{...c,x:-5000,y:-5000}:c);
  const routes=updateConnectionGeometry(before,moved,connections,1);
  const next=createEditorPicker(moved,connections,routes.paths,old.snapshot,1);
  expect(next.changedComponents).toBe(1);expect(next.changedWires).toBe(1);
  expect(next.snapshot.bodies.overlaySize).toBe(1);
  expect(next.portAt({x:0,y:20},0)).toBeNull();
  expect(next.portAt({x:-5000,y:-4980},0)?.comp.id).toBe(1);
  expect(old.portAt({x:0,y:20},0)?.comp.id).toBe(1);
  const empty=createEditorPicker([],[],new Map(),next.snapshot,1);
  expect(empty.visibleIn({left:-10000,right:10000,top:-10000,bottom:10000})).toEqual({components:[],connections:[]});
});
