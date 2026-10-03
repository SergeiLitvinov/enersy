import { describe, expect, it } from 'vitest';
import { connectionPoints, containsComponent, distanceToPolyline, worldPorts } from './editor-geometry';
import { EditorComponent, EditorConnection } from './editor-utils';

const component = (id: number, x = 0, y = 0, rotation = 0): EditorComponent => ({ id, revision: '1', x, y, rotation, type: 'transmission_line', typeId: 1, name: 'line', params: {} });
const connection: EditorConnection = { id: 1, from: 1, to: 2, fromPort: 'right', toPort: 'left' };

describe('Editor geometry regressions', () => {
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
});
