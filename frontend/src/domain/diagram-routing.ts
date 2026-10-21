/** Geometry only: route crossings never create electrical junctions. */
export interface DiagramPoint { x: number; y: number }
export interface DiagramBox { left: number; right: number; top: number; bottom: number }
export interface RouteEndpoint { point: DiagramPoint; direction: DiagramPoint; box: DiagramBox }
const EPS = 1e-7;
const CLEARANCE = 18;

function rayInterval(p: DiagramPoint, d: DiagramPoint, box: DiagramBox): [number, number] | null {
  let low = -Infinity, high = Infinity;
  for (const [value, delta, min, max] of [[p.x, d.x, box.left, box.right], [p.y, d.y, box.top, box.bottom]]) {
    if (Math.abs(delta) < EPS) {
      if (value <= min + EPS || value >= max - EPS) return null;
    } else {
      const a = (min + EPS - value) / delta, b = (max - EPS - value) / delta;
      low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
      if (high <= low) return null;
    }
  }
  return [low, high];
}

function crosses(a: DiagramPoint, b: DiagramPoint, box: DiagramBox) {
  const interval = rayInterval(a, { x: b.x - a.x, y: b.y - a.y }, box);
  return interval !== null && Math.max(0, interval[0]) < Math.min(1, interval[1]);
}

function stub(endpoint: RouteEndpoint, other: RouteEndpoint): DiagramPoint {
  const { point: p, direction: d, box } = endpoint;
  const exit = rayInterval(p, d, box);
  let distance = Math.max(0, exit?.[1] ?? 0) + CLEARANCE;
  const entry = rayInterval(p, d, other.box);
  if (entry && entry[0] > EPS) distance = Math.min(distance, entry[0] / 2);
  return { x: p.x + d.x * distance, y: p.y + d.y * distance };
}

function outward(endpoint: RouteEndpoint, next: DiagramPoint) {
  const dx = next.x - endpoint.point.x, dy = next.y - endpoint.point.y;
  return dx * endpoint.direction.x + dy * endpoint.direction.y > EPS &&
    Math.abs(dx * endpoint.direction.y - dy * endpoint.direction.x) < EPS;
}

function simplify(points: DiagramPoint[]) {
  const result: DiagramPoint[] = [];
  for (const point of points) {
    const a = result[result.length-2], b = result[result.length-1];
    if (b && Math.hypot(point.x - b.x, point.y - b.y) < EPS) continue;
    if (a && b) {
      const cross = (b.x-a.x)*(point.y-b.y) - (b.y-a.y)*(point.x-b.x);
      const dot = (b.x-a.x)*(point.x-b.x) + (b.y-a.y)*(point.y-b.y);
      if (Math.abs(cross) < EPS && dot >= 0) result.pop();
    }
    result.push(point);
  }
  return result;
}

/** Bounded candidate search around the two endpoint footprints. It does not
 * search the whole sheet or promise obstacle avoidance for unrelated objects.
 * Return null for overlapping/impossible layouts so the caller can retain a
 * visible connection rather than silently removing an electrical edge.
 */
export function routeBetweenTerminals(a: RouteEndpoint, b: RouteEndpoint): DiagramPoint[] | null {
  const s = stub(a, b), t = stub(b, a);
  const core: DiagramPoint[][] = [
    [s, {x:t.x,y:s.y}, t], [s, {x:s.x,y:t.y}, t],
  ];
  for (const x of [(s.x+t.x)/2, Math.min(a.box.left,b.box.left)-CLEARANCE, Math.max(a.box.right,b.box.right)+CLEARANCE]) {
    core.push([s,{x,y:s.y},{x,y:t.y},t]);
  }
  for (const y of [(s.y+t.y)/2, Math.min(a.box.top,b.box.top)-CLEARANCE, Math.max(a.box.bottom,b.box.bottom)+CLEARANCE]) {
    core.push([s,{x:s.x,y},{x:t.x,y},t]);
  }
  const candidates = core.map(points => [a.point, ...points, b.point]);
  if (Math.abs(a.point.x-b.point.x) < EPS || Math.abs(a.point.y-b.point.y) < EPS) candidates.push([a.point,b.point]);
  let best: DiagramPoint[] | null = null, bestCost = Infinity;
  for (const raw of candidates) {
    const points = simplify(raw);
    if (points.length < 2 || !outward(a, points[1]) || !outward(b, points[points.length-2])) continue;
    // Only the short escape lead may lie inside its own rotated AABB.
    // Check raw segments so simplification cannot erase that distinction.
    if (raw.some((p,i) => i > 0 &&
      ((i !== 1 && crosses(raw[i-1],p,a.box)) ||
       (i !== raw.length-1 && crosses(raw[i-1],p,b.box))))) continue;
    const length = points.slice(1).reduce((sum,p,i) => sum + Math.hypot(p.x-points[i].x,p.y-points[i].y),0);
    const cost = length + (points.length-2)*12;
    if (cost < bestCost - EPS) { best = points; bestCost = cost; }
  }
  return best;
}
