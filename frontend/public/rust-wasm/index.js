import init, {
  snap_to_grid,
  distance,
  normalize_angle,
  rotate_point,
  is_graph_connected,
  has_cycles,
  validate_connection,
} from './rust_wasm.js';

const wasmPath = '/rust-wasm/rust_wasm_bg.wasm';

init(wasmPath)
  .then(() => {
    window.rust_wasm = {
      snapToGrid: (x, y, gridSize) => snap_to_grid(x, y, gridSize),
      distance: (x1, y1, x2, y2) => distance(x1, y1, x2, y2),
      normalizeAngle: (deg) => normalize_angle(deg),
      rotatePoint: (x, y, cx, cy, angleDeg) => rotate_point(x, y, cx, cy, angleDeg),
      isGraphConnected: (nodeCount, edges) => is_graph_connected(nodeCount, edges),
      hasCycles: (nodeCount, edges) => has_cycles(nodeCount, edges),
      validateConnection: (typeA, typeB) => validate_connection(typeA, typeB),
    };
    console.log('WASM initialized (EES utilities)');
  })
  .catch(err => {
    console.error('WASM init failed:', err);
  });