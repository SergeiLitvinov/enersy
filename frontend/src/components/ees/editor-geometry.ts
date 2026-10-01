import { EditorComponent, EditorConnection, getCompSize, getPorts, rotatePoint } from './editor-utils';

export interface Point { x: number; y: number }

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
export function connectionPoints(connection: EditorConnection, components: EditorComponent[]): Point[] | null {
  const from = components.find(c => c.id === connection.from);
  const to = components.find(c => c.id === connection.to);
  if (!from || !to) return null;
  const a = worldPorts(from).find(p => p.name === connection.fromPort);
  const b = worldPorts(to).find(p => p.name === connection.toPort);
  if (!a || !b) return null;
  if (a.x === b.x || a.y === b.y) return [a, b];
  if (Math.abs(a.x - b.x) > Math.abs(a.y - b.y)) {
    const x = (a.x + b.x) / 2;
    return [a, { x, y: a.y }, { x, y: b.y }, b];
  }
  const y = (a.y + b.y) / 2;
  return [a, { x: a.x, y }, { x: b.x, y }, b];
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
