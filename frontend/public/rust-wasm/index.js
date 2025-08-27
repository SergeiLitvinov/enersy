// public/rust-wasm/index.js
import init, { fibonacci } from './rust_wasm.js';

const wasmPath = '/rust-wasm/rust_wasm_bg.wasm';

init(wasmPath)
  .then(() => {
    window.rust_wasm = {
      fibonacci,
    };
    console.log('WASM initialized');
  })
  .catch(err => {
    console.error('WASM init failed:', err);
  });