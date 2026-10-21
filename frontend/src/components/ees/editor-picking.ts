import {type SpatialBox} from '../../domain/spatial-index';
import {UpdatableSpatialIndex,type KeyedSpatialEntry,type SpatialChange} from '../../domain/updatable-spatial-index';
import { componentBounds,componentVisualBounds, containsComponent, distanceToPolyline, worldPorts, type Point } from './editor-geometry';
import { getCompSize,type EditorComponent,type EditorConnection } from './editor-utils';

interface PortHit { componentId:number; port:ReturnType<typeof worldPorts>[number]; portOrder:number; targetRadius:number }
interface WireHit { connectionId:number; a:Point; b:Point }
interface ComponentShape {
  signature:readonly (string|number)[];
  body:KeyedSpatialEntry<number,number>;visual:KeyedSpatialEntry<number,number>;
  ports:KeyedSpatialEntry<string,PortHit>[];
}
interface WireShape { points:Point[]|null|undefined;segments:KeyedSpatialEntry<string,WireHit>[] }
export interface EditorPickerSnapshot {
  readonly scope:unknown;
  readonly components:ReadonlyMap<number,ComponentShape>;readonly wires:ReadonlyMap<number,WireShape>;
  readonly bodies:UpdatableSpatialIndex<number,number>;readonly visuals:UpdatableSpatialIndex<number,number>;
  readonly ports:UpdatableSpatialIndex<string,PortHit>;readonly segments:UpdatableSpatialIndex<string,WireHit>;
}

function updateIndex<K,T>(before:UpdatableSpatialIndex<K,T>|undefined,changes:SpatialChange<K,T>[]){
  return before?before.update(changes):UpdatableSpatialIndex.build(changes.filter(change=>change.entry!==null).map(change=>({key:change.key,...change.entry!})));
}

function area(p:Point,radius=0) {
  return {left:p.x-radius,right:p.x+radius,top:p.y-radius,bottom:p.y+radius};
}

/** One private index per graph geometry snapshot. Array ordering preserves
 * existing overlap/paint priority; the BVH only rejects distant candidates.
 */
function buildPickerSnapshot(components:EditorComponent[],connections:EditorConnection[],paths:ReadonlyMap<number,Point[]|null>,previous:EditorPickerSnapshot|null,scope:unknown) {
  const reusable=previous?.scope===scope?previous:null;
  const shapes=new Map<number,ComponentShape>(),wireShapes=new Map<number,WireShape>();
  const bodies:SpatialChange<number,number>[]=[],visuals:SpatialChange<number,number>[]=[],ports:SpatialChange<string,PortHit>[]=[],wires:SpatialChange<string,WireHit>[]=[];
  let changedComponents=0,changedWires=0;
  const removePorts=(shape:ComponentShape)=>{for(const entry of shape.ports)ports.push({key:entry.key,entry:null});};
  components.forEach(component=>{
    const {w,h}=getCompSize(component.type);
    const signature=[component.type,component.x,component.y,component.rotation,w,h,component.name];
    const old=reusable?.components.get(component.id);
    if(old && signature.every((value,i)=>value===old.signature[i])){shapes.set(component.id,old);return;}
    changedComponents++;
    if(old)removePorts(old);
    const componentPorts=worldPorts(component);
    const shape:ComponentShape={signature,body:{key:component.id,box:componentBounds(component),value:component.id},
      visual:{key:component.id,box:componentVisualBounds(component),value:component.id},ports:[]};
    componentPorts.forEach((port,portOrder)=>{
      const toCentre=Math.hypot(port.x-component.x-w/2,port.y-component.y-h/2);
      const toNeighbour=Math.min(...componentPorts.filter(other=>other!==port)
        .map(other=>Math.hypot(port.x-other.x,port.y-other.y)));
      // Keep the centre selectable and leave a gap between adjacent targets.
      // Six world units cover the port's hover circle even on a small symbol.
      const targetRadius=Math.max(6,Math.min(toCentre/2,toNeighbour*0.45));
      shape.ports.push({key:`${component.id}:${portOrder}`,box:area(port),value:{componentId:component.id,port,portOrder,targetRadius}});
    });
    shapes.set(component.id,shape);
    bodies.push({key:component.id,entry:shape.body});visuals.push({key:component.id,entry:shape.visual});
    for(const entry of shape.ports)ports.push({key:entry.key,entry});
  });
  for(const [id,old] of reusable?.components??[])if(!shapes.has(id)){
    changedComponents++;
    bodies.push({key:id,entry:null});visuals.push({key:id,entry:null});removePorts(old);
  }
  connections.forEach(connection=>{
    const points=paths.get(connection.id);
    const old=reusable?.wires.get(connection.id);
    if(old && old.points===points){wireShapes.set(connection.id,old);return;}
    changedWires++;
    if(old)for(const entry of old.segments)wires.push({key:entry.key,entry:null});
    const shape:WireShape={points,segments:[]};
    points?.slice(1).forEach((b,i)=>{
      const a=points[i];
      shape.segments.push({key:`${connection.id}:${i}`,box:{left:Math.min(a.x,b.x),right:Math.max(a.x,b.x),top:Math.min(a.y,b.y),bottom:Math.max(a.y,b.y)},
        value:{connectionId:connection.id,a,b}});
    });
    wireShapes.set(connection.id,shape);
    for(const entry of shape.segments)wires.push({key:entry.key,entry});
  });
  for(const [id,old] of reusable?.wires??[])if(!wireShapes.has(id)){
    changedWires++;
    for(const entry of old.segments)wires.push({key:entry.key,entry:null});
  }
  const bodyIndex=updateIndex(reusable?.bodies,bodies),portIndex=updateIndex(reusable?.ports,ports),wireIndex=updateIndex(reusable?.segments,wires);
  const visualIndex=updateIndex(reusable?.visuals,visuals);
  const snapshot:EditorPickerSnapshot={scope,components:shapes,wires:wireShapes,bodies:bodyIndex,ports:portIndex,segments:wireIndex,visuals:visualIndex};
  return {snapshot,changedComponents,changedWires};
}

/** Query closures must not share the builder's lexical context: temporary
 * callbacks there capture the old snapshot and would keep its history alive.
 */
function createQueries(components:EditorComponent[],connections:EditorConnection[],built:ReturnType<typeof buildPickerSnapshot>){
  const {snapshot,changedComponents,changedWires}=built;
  const {bodies:bodyIndex,ports:portIndex,segments:wireIndex,visuals:visualIndex,components:shapes}=snapshot;
  const byComponent=new Map(components.map((component,order)=>[component.id,{component,order}]));
  const byConnection=new Map(connections.map((connection,order)=>[connection.id,{connection,order}]));
  let maxTargetRadius=0;
  for(const shape of shapes.values())for(const entry of shape.ports)maxTargetRadius=Math.max(maxTargetRadius,entry.value.targetRadius);
  function pickPort(point:Point,radius:number,bounded:boolean) {
    const hits=portIndex.search(area(point,bounded?Math.min(radius,maxTargetRadius):radius)).values
      .map(hit=>({...hit,...byComponent.get(hit.componentId)!}))
      .map(hit=>({hit,distance:Math.hypot(point.x-hit.port.x,point.y-hit.port.y)}))
      .filter(({hit,distance})=>distance<=Math.min(radius,bounded?hit.targetRadius:Infinity))
      .sort((a,b)=>(bounded?a.distance-b.distance:0) || b.hit.order-a.hit.order || a.hit.portOrder-b.hit.portOrder);
    const hit=hits[0]?.hit;
    return hit?{comp:hit.component,port:hit.port}:null;
  }
  return {
    snapshot,changedComponents,changedWires,
    visibleIn(box:SpatialBox,componentPins:readonly number[]=[],connectionPins:readonly number[]=[]) {
      const visibleComponents=new Map(visualIndex.search(box).values.map(id=>[id,byComponent.get(id)!]));
      // Stroke width is in world units (up to 3 on hover), so pixel
      // overscan alone cannot cover its edge at extreme zoom.
      const wireBox={left:box.left-2,right:box.right+2,top:box.top-2,bottom:box.bottom+2};
      const visibleConnections=new Map(wireIndex.search(wireBox).values.map(v=>[v.connectionId,byConnection.get(v.connectionId)!]));
      for(const id of componentPins){const item=byComponent.get(id);if(item)visibleComponents.set(id,item);}
      // Selected wires may not have renderable endpoints; retaining their ID
      // still permits diagnostics without inventing a route.
      const orderedConnections=new Map([...visibleConnections].map(([id,v])=>[id,{connection:v.connection,order:v.order}]));
      for(const id of connectionPins){const item=byConnection.get(id);if(item)orderedConnections.set(id,item);}
      return {components:[...visibleComponents.values()].sort((a,b)=>a.order-b.order).map(v=>v.component),
        connections:[...orderedConnections.values()].sort((a,b)=>a.order-b.order).map(v=>v.connection)};
    },
    portAt(point:Point,radius:number) {
      return pickPort(point,radius,false);
    },
    /** Pointer targets shrink with the symbol at overview scales. Prefer the
     * nearest target; coincident ports retain paint/declared-port priority.
     */
    portTargetAt(point:Point,radius:number) {
      return pickPort(point,radius,true);
    },
    componentAt(point:Point) {
      return bodyIndex.search(area(point)).values.map(id=>byComponent.get(id)!).sort((a,b)=>b.order-a.order)
        .find(p=>containsComponent(p.component,point))?.component ?? null;
    },
    connectionAt(point:Point,radius:number) {
      return wireIndex.search(area(point,radius)).values.map(hit=>({...hit,...byConnection.get(hit.connectionId)!})).sort((a,b)=>a.order-b.order)
        .find(p=>distanceToPolyline(point,[p.a,p.b])<=radius)?.connection ?? null;
    },
    candidateCounts(point:Point,radius:number) {
      const b=bodyIndex.search(area(point)),p=portIndex.search(area(point,radius)),w=wireIndex.search(area(point,radius));
      return {bodies:b.values.length,ports:p.values.length,segments:w.values.length,
        visitedNodes:b.visitedNodes+p.visitedNodes+w.visitedNodes};
    },
  };
}

export function createEditorPicker(components:EditorComponent[],connections:EditorConnection[],paths:ReadonlyMap<number,Point[]|null>,previous:EditorPickerSnapshot|null=null,scope:unknown=undefined) {
  return createQueries(components,connections,buildPickerSnapshot(components,connections,paths,previous,scope));
}
