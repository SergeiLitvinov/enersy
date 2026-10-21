import { EditorComponent, EditorConnection, getCompSize, getPorts, getPortDirection, rotatePoint } from './editor-utils';
import { routeBetweenTerminals, type RouteEndpoint } from '../../domain/diagram-routing';

export interface Point { x: number; y: number }

export function componentBounds(component: EditorComponent) {
  const {w,h}=getCompSize(component.type);
  const corners=[[0,0],[w,0],[0,h],[w,h]].map(([x,y])=>rotatePoint(x,y,w/2,h/2,component.rotation));
  return {left:component.x+Math.min(...corners.map(p=>p.x)),right:component.x+Math.max(...corners.map(p=>p.x)),
    top:component.y+Math.min(...corners.map(p=>p.y)),bottom:component.y+Math.max(...corners.map(p=>p.y))};
}

/** Conservative bounds for the body and rotated name label. Selection controls
 * are retained separately by pinning selected/focused objects during culling.
 */
export function componentVisualBounds(component:EditorComponent) {
  const body=componentBounds(component),{w,h}=getCompSize(component.type);
  const halfLabel=Math.max(w/2,component.name.length*5+8);
  const corners=[[-halfLabel,h],[halfLabel,h],[-halfLabel,h+18],[halfLabel,h+18]]
    .map(([offset,y])=>rotatePoint(w/2+offset,y,w/2,h/2,component.rotation));
  // Port markers extend four world units beyond the body even at high zoom.
  return {left:Math.min(body.left-4,...corners.map(p=>component.x+p.x)),right:Math.max(body.right+4,...corners.map(p=>component.x+p.x)),
    top:Math.min(body.top-4,...corners.map(p=>component.y+p.y)),bottom:Math.max(body.bottom+4,...corners.map(p=>component.y+p.y))};
}

/** Same order as SVG: local scale, rotation around displayed centre, translation. */
export function worldPorts(component: EditorComponent) {
  const { w, h } = getCompSize(component.type);
  return getPorts(component.type, w, h).map(port => {
    const rotated = rotatePoint(port.x, port.y, w / 2, h / 2, component.rotation);
    return { name: port.name, x: component.x + rotated.x, y: component.y + rotated.y };
  });
}

export function containsComponent(component: EditorComponent, point: Point) {
  const { w, h } = getCompSize(component.type);
  const local = rotatePoint(point.x - component.x, point.y - component.y, w / 2, h / 2, -component.rotation);
  return local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h;
}

/** Drawing and hit testing must use the same polyline, never its diagonal chord. */
export function connectionPoints(connection: EditorConnection, components: EditorComponent[] | Pick<ReadonlyMap<number, EditorComponent>,'get'>): Point[] | null {
  const from = Array.isArray(components) ? components.find(c => c.id === connection.from) : components.get(connection.from);
  const to = Array.isArray(components) ? components.find(c => c.id === connection.to) : components.get(connection.to);
  if (!from || !to) return null;
  const a = worldPorts(from).find(p => p.name === connection.fromPort);
  const b = worldPorts(to).find(p => p.name === connection.toPort);
  if (!a || !b) return null;
  function endpoint(c: EditorComponent, point: Point, port: string): RouteEndpoint {
    const direction = getPortDirection(port);
    const local = direction === 'left' ? [-1,0] : direction === 'right' ? [1,0] : direction === 'top' ? [0,-1] : [0,1];
    const angle = c.rotation * Math.PI/180;
    const dx = local[0]*Math.cos(angle)-local[1]*Math.sin(angle), dy = local[0]*Math.sin(angle)+local[1]*Math.cos(angle);
    return { point, direction: {x:Math.abs(dx)<1e-12?0:dx,y:Math.abs(dy)<1e-12?0:dy},
      box:componentBounds(c) };
  }
  // Canonical orientation keeps an identical route when a stored wire is reversed.
  const forward = from.id < to.id || (from.id === to.id && connection.fromPort <= connection.toPort);
  const first = endpoint(from,a,connection.fromPort), last = endpoint(to,b,connection.toPort);
  const routed = forward ? routeBetweenTerminals(first,last) : routeBetweenTerminals(last,first)?.reverse();
  if (routed) return routed;
  // Overlapping footprints may have no collision-free route. Keep the original
  // visible fallback; geometry never removes or rewires the electrical graph.
  if (a.x === b.x || a.y === b.y) return [a, b];
  if (Math.abs(a.x - b.x) > Math.abs(a.y - b.y)) {
    const x = (a.x + b.x) / 2;
    return [a, { x, y: a.y }, { x, y: b.y }, b];
  }
  const y = (a.y + b.y) / 2;
  return [a, { x: a.x, y }, { x: b.x, y }, b];
}

/** Index once per graph snapshot; callers share these paths for paint/picking. */
export function connectionGeometry(components: EditorComponent[], connections: EditorConnection[]) {
  const index = new Map(components.map(c => [c.id,c]));
  return new Map(connections.map(c => [c.id,connectionPoints(c,index)]));
}

/** Bind adjacency once; each pointer frame touches only the moving endpoint
 * and incident wires, leaving committed maps and equipment unchanged.
 */
export function createMoveGeometry(components:EditorComponent[],connections:EditorConnection[]) {
  const index=new Map(components.map(c=>[c.id,c]));
  const adjacent=new Map<number,EditorConnection[]>();
  for(const connection of connections) for(const id of new Set([connection.from,connection.to])) {
    const list=adjacent.get(id)??[];list.push(connection);adjacent.set(id,list);
  }
  const empty:EditorConnection[]=[];
  return (movement:{componentId:number;x:number;y:number}|null)=>{
    if(!movement)return null;
    const original=index.get(movement.componentId);
    if(!original || !Number.isFinite(movement.x) || !Number.isFinite(movement.y))return null;
    const component={...original,x:movement.x,y:movement.y};
    const lookup={get:(id:number)=>id===component.id?component:index.get(id)};
    const incident=adjacent.get(component.id)??empty;
    return {component,connections:incident,paths:new Map(incident.map(c=>[c.id,connectionPoints(c,lookup)]))};
  };
}

export function distanceToPolyline(point: Point, points: Point[]) {
  let distance = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t = squared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return distance;
}
