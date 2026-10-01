import { ComponentParam } from './svg-components';

export interface EditorComponent {
  equipmentModelId?: number | null;
  id: number;
  type: string;
  typeId: number;
  name: string;
  x: number;
  y: number;
  rotation: number;
  params: Record<string, string>;
  paramTemplate?: ComponentParam[];
}

export interface EditorConnection {
  validationErrors?: string[];
  id: number;
  from: number;
  to: number;
  fromPort: string;
  toPort: string;
}

export interface Port {
  x: number;
  y: number;
  name: string;
}

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DragMode = 'move' | 'connect' | 'pan' | null;

export interface DragData {
  compId?: number;
  offsetX?: number;
  offsetY?: number;
  portName?: string;
  startX?: number;
  startY?: number;
  vb?: ViewBox;
}

export interface TempLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const COMP_SIZES: Record<string, { w: number; h: number }> = {
  generator: { w: 60, h: 60 },
  transformer: { w: 60, h: 80 },
  transmission_line: { w: 100, h: 40 },
  breaker: { w: 50, h: 60 },
  disconnector: { w: 50, h: 60 },
  load: { w: 60, h: 60 },
  ground: { w: 50, h: 40 },
  busbar: { w: 120, h: 30 },
  transformer_3w: { w: 60, h: 90 },
  autotransformer: { w: 60, h: 80 },
  grounding_switch: { w: 50, h: 60 },
  capacitor: { w: 60, h: 60 },
  reactor: { w: 60, h: 70 },
};

export const NATIVE_SIZES: Record<string, { w: number; h: number }> = {
  generator: { w: 60, h: 60 },
  transformer: { w: 60, h: 80 },
  transmission_line: { w: 100, h: 40 },
  breaker: { w: 50, h: 60 },
  disconnector: { w: 50, h: 60 },
  load: { w: 60, h: 60 },
  ground: { w: 50, h: 40 },
  busbar: { w: 120, h: 30 },
  transformer_3w: { w: 60, h: 90 },
  autotransformer: { w: 60, h: 80 },
  grounding_switch: { w: 50, h: 60 },
  capacitor: { w: 60, h: 60 },
  reactor: { w: 60, h: 70 },
};

export function getPorts(type: string, w: number, h: number): Port[] {
  const cx = w / 2;
  switch (type) {
    case 'busbar':
      return [{ x: 0, y: h / 2, name: 'left' }, { x: w, y: h / 2, name: 'right' }];
    case 'transmission_line':
      return [{ x: 0, y: h / 2, name: 'left' }, { x: w, y: h / 2, name: 'right' }];
    case 'load': case 'ground': case 'grounding_switch': case 'capacitor': case 'reactor':
      return [{ x: cx, y: 0, name: 'top' }];
    case 'transformer_3w':
      return [
        { x: cx, y: 0, name: 'top' },
        { x: 8, y: h, name: 'bl' },
        { x: w - 8, y: h, name: 'br' },
      ];
    default:
      return [{ x: cx, y: 0, name: 'top' }, { x: cx, y: h, name: 'bottom' }];
  }
}

export function getCompSize(type: string) {
  return COMP_SIZES[type] || { w: 30, h: 30 };
}

export function getPortDirection(name: string): string {
  if (name === 'left') return 'left';
  if (name === 'right') return 'right';
  if (name === 'top') return 'top';
  if (name === 'bottom') return 'bottom';
  if (name === 'bl' || name === 'br') return 'bottom';
  return 'top';
}

export function rotatePoint(px: number, py: number, cx: number, cy: number, angleDeg: number) {
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}
