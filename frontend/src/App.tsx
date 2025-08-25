import { useEffect, useState } from 'react';

function App() {
  const [result, setResult] = useState<string>('');

  const callGo = async (service: string) => {
    const data = { A: [2, 1], B: [5, 7] };
    const res = await fetch(`http://localhost:8080/${service}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    setResult(`${service} result: ${JSON.stringify(json)}`);
  };

  const runFibonacci = async () => {
    try {
      const wasm = await import('./rust-wasm/rust_wasm.js');
      const fib = wasm.fibonacci(35);
      setResult(`Fibonacci(35) = ${fib}`);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial' }}>
      <h1>Hybrid Web Stack</h1>
      <button onClick={() => callGo('python')} style={{ margin: '5px' }}>
        Вызвать Python
      </button>
      <button onClick={() => callGo('julia')} style={{ margin: '5px' }}>
        Вызвать Julia
      </button>
      <button onClick={runFibonacci} style={{ margin: '5px' }}>
        Запустить Rust (WASM)
      </button>
      {result && <pre style={{ marginTop: '20px' }}>{result}</pre>}
    </div>
  );
}

export default App;