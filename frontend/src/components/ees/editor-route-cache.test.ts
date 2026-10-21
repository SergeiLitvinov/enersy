import {expect,test} from 'vitest';
import {connectionGeometry} from './editor-geometry';
import {updateConnectionGeometry} from './editor-route-cache';
import type {EditorComponent,EditorConnection} from './editor-utils';

function fixture(count=5){
  const components:EditorComponent[]=Array.from({length:count},(_,i)=>({id:i+1,type:'transmission_line',typeId:1,
    revision:'1',name:`Line ${i}`,x:i*250,y:0,rotation:0,params:{}}));
  const connections:EditorConnection[]=components.slice(1).map((c,i)=>({id:i+1,from:i+1,to:c.id,fromPort:'right',toPort:'left'}));
  return {components,connections};
}

test('a committed move reroutes only incident wires and agrees with a complete rebuild',()=>{
  const {components,connections}=fixture();
  const before=updateConnectionGeometry(null,components,connections,1);
  const saved=JSON.stringify([...before.paths]);
  const moved=components.map(c=>c.id===3?{...c,x:c.x+30,y:90}:c);
  const after=updateConnectionGeometry(before,moved,connections,1);
  expect(after.recomputedRoutes).toBe(2);
  expect([...after.paths]).toEqual([...connectionGeometry(moved,connections)]);
  expect(after.paths.get(1)).toBe(before.paths.get(1));
  expect(after.paths.get(4)).toBe(before.paths.get(4));
  expect(after.paths.get(2)).not.toBe(before.paths.get(2));
  expect(JSON.stringify([...before.paths])).toBe(saved);
});

test('parameter, passport, name, revision and validation changes retain existing route objects',()=>{
  const {components,connections}=fixture();
  const before=updateConnectionGeometry(null,components,connections,1);
  const changed=components.map(c=>({...c,revision:'2',name:'Renamed',params:{r0:'9'},equipmentModelId:77}));
  const after=updateConnectionGeometry(before,changed,connections.map(c=>({...c,validationErrors:['diagnostic']})),1);
  expect(after.recomputedRoutes).toBe(0);
  for(const connection of connections)expect(after.paths.get(connection.id)).toBe(before.paths.get(connection.id));
});

test('rotation, type and port bindings invalidate the affected routes; deleted and invalid routes do not linger',()=>{
  const {components,connections}=fixture();
  let snapshot=updateConnectionGeometry(null,components,connections,1);
  const rotated=components.map(c=>c.id===3?{...c,rotation:37}:c);
  snapshot=updateConnectionGeometry(snapshot,rotated,connections,1);
  expect(snapshot.recomputedRoutes).toBe(2);
  expect([...snapshot.paths]).toEqual([...connectionGeometry(rotated,connections)]);
  const typed=rotated.map(c=>c.id===3?{...c,type:'transformer'}:c);
  snapshot=updateConnectionGeometry(snapshot,typed,connections,1);
  expect(snapshot.recomputedRoutes).toBe(2);
  expect(snapshot.paths.get(2)).toBeNull();expect(snapshot.paths.get(3)).toBeNull();
  const rebound=connections.map(c=>c.id===2?{...c,toPort:'top'}:c.id===3?{...c,fromPort:'bottom'}:c);
  snapshot=updateConnectionGeometry(snapshot,typed,rebound,1);
  expect(snapshot.recomputedRoutes).toBe(2);
  expect([...snapshot.paths]).toEqual([...connectionGeometry(typed,rebound)]);
  snapshot=updateConnectionGeometry(snapshot,typed,rebound.filter(c=>c.id!==2),1);
  expect(snapshot.paths.has(2)).toBe(false);expect(snapshot.routes.has(2)).toBe(false);
  expect(snapshot.recomputedRoutes).toBe(0);
});

test('reused connection IDs and missing endpoints cannot return an old visible path',()=>{
  const {components,connections}=fixture();
  const before=updateConnectionGeometry(null,components,connections,1);
  const rewired=[{...connections[0],from:4,to:5}];
  const next=updateConnectionGeometry(before,components,rewired,1);
  expect(next.recomputedRoutes).toBe(1);
  expect([...next.paths]).toEqual([...connectionGeometry(components,rewired)]);
  const removed=updateConnectionGeometry(next,components.filter(c=>c.id!==5),rewired,1);
  expect(removed.paths.get(1)).toBeNull();
  const restored=updateConnectionGeometry(removed,components,rewired,1);
  expect(restored.recomputedRoutes).toBe(1);
  expect([...restored.paths]).toEqual([...connectionGeometry(components,rewired)]);
});

test('scope changes rebuild all paths, and independent candidate snapshots cannot mutate their common base',()=>{
  const {components,connections}=fixture();
  const before=updateConnectionGeometry(null,components,connections,'A');
  const saved=JSON.stringify([...before.paths]);
  updateConnectionGeometry(before,components.map(c=>({...c,x:c.x+1000})),connections,'B');
  const b=updateConnectionGeometry(before,components,connections,'B');
  const a=updateConnectionGeometry(b,components,connections,'A');
  expect(b.recomputedRoutes).toBe(connections.length);expect(a.recomputedRoutes).toBe(connections.length);
  expect(a.paths.get(1)).not.toBe(before.paths.get(1));
  expect(JSON.stringify([...before.paths])).toBe(saved);
  expect(updateConnectionGeometry(before,[],[],'A').paths.size).toBe(0);
});

test('copied endpoint poses detect in-place input changes rather than retaining mutable component references',()=>{
  const {components,connections}=fixture();
  const before=updateConnectionGeometry(null,components,connections,1);
  components[0].x=1000;
  const after=updateConnectionGeometry(before,components,connections,1);
  expect(after.recomputedRoutes).toBe(1);
  expect([...after.paths]).toEqual([...connectionGeometry(components,connections)]);
  expect(before.poses.get(1)?.x).toBe(0);
});
