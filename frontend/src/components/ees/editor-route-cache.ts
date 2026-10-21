import {connectionPoints,type Point} from './editor-geometry';
import {getCompSize,type EditorComponent,type EditorConnection} from './editor-utils';

type Pose=Readonly<Pick<EditorComponent,'id'|'type'|'x'|'y'|'rotation'>&{w:number;h:number}>;
interface Route {
  readonly from:number;readonly to:number;readonly fromPort:string;readonly toPort:string;
  readonly a:Pose|undefined;readonly b:Pose|undefined;readonly points:Point[]|null;
}
export interface RouteSnapshot {
  readonly scope:unknown;
  readonly poses:ReadonlyMap<number,Pose>;
  readonly routes:ReadonlyMap<number,Route>;
  readonly paths:ReadonlyMap<number,Point[]|null>;
  readonly recomputedRoutes:number;
}

/** Immutable, editor-local snapshots. Only endpoint geometry and port bindings
 * affect today's two-endpoint router; no passport/parameter data is retained.
 * A future router that avoids other objects must add those dependencies here.
 */
export function updateConnectionGeometry(previous:RouteSnapshot|null,components:EditorComponent[],connections:EditorConnection[],scope:unknown):RouteSnapshot {
  const reusable=previous?.scope===scope?previous:null;
  const poses=new Map<number,Pose>(),index=new Map<number,EditorComponent>();
  for(const component of components){
    const {id,type,x,y,rotation}=component,{w,h}=getCompSize(type);
    const old=reusable?.poses.get(id);
    poses.set(id,old && old.type===type && old.x===x && old.y===y && old.rotation===rotation && old.w===w && old.h===h
      ?old:{id,type,x,y,rotation,w,h});
    index.set(id,component);
  }
  const routes=new Map<number,Route>(),paths=new Map<number,Point[]|null>();
  let recomputedRoutes=0;
  for(const connection of connections){
    const {id,from,to,fromPort,toPort}=connection;
    const a=poses.get(from),b=poses.get(to),old=reusable?.routes.get(id);
    const unchanged=old && old.from===from && old.to===to && old.fromPort===fromPort && old.toPort===toPort && old.a===a && old.b===b;
    const route=unchanged?old:{from,to,fromPort,toPort,a,b,points:connectionPoints(connection,index)};
    if(!unchanged)recomputedRoutes++;
    routes.set(id,route);paths.set(id,route.points);
  }
  return {scope,poses,routes,paths,recomputedRoutes};
}
