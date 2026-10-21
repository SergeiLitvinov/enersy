import { describe, expect, it } from 'vitest';
import { createMoveGeometry, connectionGeometry, connectionPoints, containsComponent, distanceToPolyline, worldPorts } from './editor-geometry';
import { EditorComponent, EditorConnection, rotatePoint } from './editor-utils';

const component = (id: number, x = 0, y = 0, rotation = 0): EditorComponent => ({ id, revision: '1', x, y, rotation, type: 'transmission_line', typeId: 1, name: 'line', params: {} });
const connection: EditorConnection = { id: 1, from: 1, to: 2, fromPort: 'right', toPort: 'left' };

describe('Editor geometry regressions', () => {
  it('leaves outward-facing terminals before returning around both equipment bodies', () => {
    const cs = [component(1, 300, 100), component(2, 0, 100)];
    const points = connectionPoints(connection, cs)!;
    expect(points[1].x).toBeGreaterThan(400);
    expect(points[1].y).toBeCloseTo(120);
    expect(points[points.length-2].x).toBeLessThan(0);
    expect(points[points.length-2].y).toBeCloseTo(120);
  });
  it.each([[0, 100, 20], [90, 50, 70], [180, 0, 20], [270, 50, -30]])('preserves right terminal identity at %d°', (rotation, x, y) => {
    const port = worldPorts(component(1, 10, 20, rotation)).find(p => p.name === 'right')!;
    expect(port.x).toBeCloseTo(x + 10, 10);
    expect(port.y).toBeCloseTo(y + 20, 10);
  });
  it('selects the rotated tall footprint instead of the old horizontal box', () => {
    const line = component(1, 0, 0, 90);
    expect(containsComponent(line, { x: 50, y: -20 })).toBe(true);
    expect(containsComponent(line, { x: 5, y: 20 })).toBe(false);
  });
  it('connects to the rotated terminal and hits each orthogonal leg', () => {
    const points = connectionPoints(connection, [component(1, 0, 0, 90), component(2, 200, 200)])!;
    expect(points[0].x).toBeCloseTo(50);
    expect(points[0].y).toBeCloseTo(70);
    expect(points[points.length - 1]).toMatchObject({ x: 200, y: 220 });
    for (let i = 1; i < points.length; i++) {
      expect(distanceToPolyline({ x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 }, points)).toBeCloseTo(0);
    }
    // The old hit test selected this empty point on the diagonal chord.
    expect(distanceToPolyline({ x: 90, y: 110 }, points)).toBeGreaterThan(30);
  });
  it('does not replace an unknown port with the first port', () => {
    expect(connectionPoints({ ...connection, fromPort: 'missing' }, [component(1), component(2)])).toBeNull();
  });
  it.each([0,90,180,270].flatMap(a => [0,90,180,270].map(b => [a,b])))('routes outside both footprints at %d° / %d°', (ra,rb) => {
    const cs = [component(1,0,0,ra),component(2,280,180,rb)];
    const points = connectionPoints(connection,cs)!;
    const first = points[0], second = points[1], last = points[points.length-1], previous = points[points.length-2];
    const a = ra*Math.PI/180, b = rb*Math.PI/180;
    expect((second.x-first.x)*Math.cos(a)+(second.y-first.y)*Math.sin(a)).toBeGreaterThan(0);
    expect((previous.x-last.x)*-Math.cos(b)+(previous.y-last.y)*-Math.sin(b)).toBeGreaterThan(0);
    for(let i=1;i<points.length;i++) {
      const p=points[i-1],q=points[i];
      expect(Math.min(Math.abs(p.x-q.x),Math.abs(p.y-q.y))).toBeLessThan(1e-7);
      // Sample the rendered path in each rotated local footprint. This is
      // independent of the router's AABB intersection/candidate search.
      for(let step=1;step<40;step++) for(const c of cs) {
        const local=rotatePoint(p.x+(q.x-p.x)*step/40-c.x,p.y+(q.y-p.y)*step/40-c.y,50,20,-c.rotation);
        expect(local.x>1e-6 && local.x<100-1e-6 && local.y>1e-6 && local.y<40-1e-6).toBe(false);
      }
      expect(distanceToPolyline({x:(p.x+q.x)/2,y:(p.y+q.y)/2},points)).toBeCloseTo(0);
    }
    const reversed=connectionPoints({...connection,from:2,to:1,fromPort:'left',toPort:'right'},[...cs].reverse())!;
    expect(reversed).toEqual([...points].reverse());
  });
  it('keeps short facing connections compact, including a narrow offset gap', () => {
    const direct=connectionPoints(connection,[component(1),component(2,105,0)])!;
    expect(direct).toHaveLength(2);
    const offset=connectionPoints(connection,[component(1),component(2,105,10)])!;
    expect(offset[1].x).toBeGreaterThan(100);
    expect(offset[offset.length-2].x).toBeLessThan(105);
    expect(offset.every(p=>p.x>=100 && p.x<=105)).toBe(true);
  });
  it('retains a visible finite connection for overlapping equipment without mutating the graph', () => {
    const cs=[component(1),component(2)];
    const before=JSON.stringify({cs,connection});
    const points=connectionPoints(connection,cs)!;
    expect(points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);
    expect(JSON.stringify({cs,connection})).toBe(before);
  });
  it('indexes only the supplied graph and rebuilds routes for new geometry with reused IDs', () => {
    const first=connectionGeometry([component(1),component(2,300,0)],[connection]);
    const next=connectionGeometry([component(1,1000,1000),component(2,1300,1000)],[connection]);
    expect(first.get(1)![0].x).toBe(100);
    expect(next.get(1)![0].x).toBe(1100);
    expect(connectionGeometry([component(1)],[connection]).get(1)).toBeNull();
  });
  it('reroutes only incident wires and retains graph data and adjacency identity across preview frames',()=>{
    const cs=[component(1),component(2,300),component(3,600)];
    const other={...connection,id:2,from:2,to:3};
    const apply=createMoveGeometry(cs,[connection,other]);
    const original=JSON.stringify(cs);
    const a=apply({componentId:1,x:80,y:90})!,b=apply({componentId:1,x:90,y:100})!;
    expect([...a.paths.keys()]).toEqual([1]);
    expect(a.connections).toBe(b.connections);
    expect(a.component).toMatchObject({x:80,y:90});
    expect(a.paths.get(1)![0]).toMatchObject({x:180,y:110});
    expect(JSON.stringify(cs)).toBe(original);
    expect(apply(null)).toBeNull();expect(apply({componentId:99,x:0,y:0})).toBeNull();
  });
});
