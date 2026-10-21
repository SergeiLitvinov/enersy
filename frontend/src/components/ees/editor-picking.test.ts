import { expect,test } from 'vitest';
import { connectionGeometry,containsComponent,distanceToPolyline,worldPorts,type Point } from './editor-geometry';
import { createEditorPicker } from './editor-picking';
import {COMP_SIZES,type EditorComponent,type EditorConnection} from './editor-utils';

test('overview port targets leave every current symbol centre selectable across rotations and scales',()=>{
  for(const [type,{w,h}] of Object.entries(COMP_SIZES)) for(const rotation of [0,37,90,180,270]){
    const component:EditorComponent={id:1,revision:'1',type,typeId:1,name:type,x:500,y:-300,rotation,params:{}};
    const picker=createEditorPicker([component],[],new Map());
    const centre={x:component.x+w/2,y:component.y+h/2};
    for(const pixelsPerUnit of [0.01,0.05,0.1,0.2,1,10,100]){
      const radius=14/pixelsPerUnit;
      expect(picker.componentAt(centre)?.id).toBe(component.id);
      expect(picker.portTargetAt(centre,radius)).toBeNull();
      for(const port of worldPorts(component))expect(picker.portTargetAt(port,radius)?.port.name).toBe(port.name);
    }
  }
});

test('pointer targets prefer the nearest port and retain paint priority for coincident ports',()=>{
  const {components}=pickingFixture(2);
  components[1]={...components[0],id:2,x:10};
  const picker=createEditorPicker(components,[],new Map());
  expect(picker.portTargetAt({x:0,y:20},14)?.comp.id).toBe(1);
  // Raw radius queries keep their original geometric/paint-order contract.
  expect(picker.portAt({x:0,y:20},14)?.comp.id).toBe(2);
  components[1]={...components[0],id:2};
  expect(createEditorPicker(components,[],new Map()).portTargetAt({x:0,y:20},14)?.comp.id).toBe(2);
});

test('viewport retains crossing wires, visible labels and pinned objects in original paint order',()=>{
  const {components}=pickingFixture(4);
  components[0]={...components[0],x:-500,y:0};
  components[1]={...components[1],x:500,y:0};
  components[2]={...components[2],x:0,y:-45,rotation:0,name:'Visible label'};
  components[3]={...components[3],x:1000,y:1000};
  const connections:EditorConnection[]=[
    {id:8,from:1,to:2,fromPort:'right',toPort:'left'},
    {id:2,from:2,to:4,fromPort:'right',toPort:'left'},
  ];
  const paths=new Map([[8,[{x:-400,y:20},{x:500,y:20}]], [2,null]]);
  const picker=createEditorPicker(components,connections,paths);
  const box={left:0,right:100,top:0,bottom:30};
  const visible=picker.visibleIn(box);
  expect(visible.components.map(c=>c.id)).toEqual([3]);
  expect(visible.connections.map(c=>c.id)).toEqual([8]);
  const pinned=picker.visibleIn(box,[4,1,4,999],[2,8,999]);
  expect(pinned.components.map(c=>c.id)).toEqual([1,3,4]);
  expect(pinned.connections.map(c=>c.id)).toEqual([8,2]);
  expect(pinned.components[0]).toBe(components[0]);
  expect(picker.visibleIn({left:2000,right:2100,top:2000,bottom:2100})).toEqual({components:[],connections:[]});
});

test('wire strokes and port circles remain visible when their centre lines lie just outside the viewport',()=>{
  const {components,connections}=pickingFixture(2);
  components[0]={...components[0],x:-103,y:0,rotation:0};
  const paths=new Map([[connections[0].id,[{x:-100,y:-1},{x:200,y:-1}]]]);
  const visible=createEditorPicker(components,connections,paths).visibleIn({left:0,right:100,top:0,bottom:30});
  expect(visible.connections).toEqual(connections);
  expect(visible.components.map(c=>c.id)).toContain(components[0].id);
});

export function pickingFixture(count:number) {
  const components:EditorComponent[]=Array.from({length:count},(_,i)=>({id:i+1,revision:'1',type:'transmission_line',typeId:1,
    name:`Line ${i}`,x:(i%100)*200,y:Math.floor(i/100)*150,rotation:(i%4)*90,params:{}}));
  const connections:EditorConnection[]=components.slice(1).map((c,i)=>({id:i+1,from:i+1,to:c.id,fromPort:'right',toPort:'left'}));
  return {components,connections};
}

export function brutePicker(components:EditorComponent[],connections:EditorConnection[],paths:ReturnType<typeof connectionGeometry>) {
  return {
    portAt(point:Point,radius:number) {
      for(let i=components.length-1;i>=0;i--) for(const port of worldPorts(components[i])) {
        if(Math.hypot(point.x-port.x,point.y-port.y)<=radius) return {comp:components[i],port};
      }
      return null;
    },
    componentAt(point:Point) { return [...components].reverse().find(c=>containsComponent(c,point))??null; },
    connectionAt(point:Point,radius:number) {
      return connections.find(c=>{const p=paths.get(c.id);return p && distanceToPolyline(point,p)<=radius;})??null;
    },
  };
}

test('indexed selection matches the previous exact tests across rotations, zoom thresholds and routed wires',()=>{
  const {components,connections}=pickingFixture(160);
  const paths=connectionGeometry(components,connections);
  const indexed=createEditorPicker(components,connections,paths),brute=brutePicker(components,connections,paths);
  const points=components.flatMap(c=>[...worldPorts(c),{x:c.x+50,y:c.y+20}]);
  for(let i=0;i<250;i++) points.push({x:(i*137)%20000,y:(i*71)%400-80});
  for(const p of points) for(const radius of [0,3,14,70]) {
    expect(indexed.portAt(p,radius)).toEqual(brute.portAt(p,radius));
    expect(indexed.componentAt(p)).toEqual(brute.componentAt(p));
    expect(indexed.connectionAt(p,radius)).toEqual(brute.connectionAt(p,radius));
  }
});

test('paint priority, port order and first-wire priority are retained for overlapping shapes',()=>{
  const {components}=pickingFixture(2);components[1]={...components[0],id:2};
  const connections:EditorConnection[]=[{id:7,from:1,to:2,fromPort:'right',toPort:'left'},{id:3,from:2,to:1,fromPort:'left',toPort:'right'}];
  const paths=new Map(connections.map(c=>[c.id,[{x:0,y:200},{x:100,y:200}]]));
  const picker=createEditorPicker(components,connections,paths);
  expect(picker.componentAt({x:50,y:20})?.id).toBe(2);
  expect(picker.portAt({x:0,y:20},0)?.comp.id).toBe(2);
  expect(picker.connectionAt({x:50,y:200},0)?.id).toBe(7);
});

test('new snapshots with reused IDs cannot leak geometry and empty graphs remain selectable as empty',()=>{
  const {components,connections}=pickingFixture(2);
  const old=createEditorPicker(components,connections,connectionGeometry(components,connections));
  const moved=components.map(c=>({...c,x:c.x+1000}));
  const next=createEditorPicker(moved,connections,connectionGeometry(moved,connections));
  expect(old.portAt({x:0,y:20},0)?.comp.id).toBe(1);
  expect(next.portAt({x:0,y:20},0)).toBeNull();
  expect(next.portAt({x:1000,y:20},0)?.comp.id).toBe(1);
  expect(createEditorPicker([],[],new Map()).componentAt({x:0,y:0})).toBeNull();
});
