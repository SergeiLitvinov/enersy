import { useState } from 'react';

// Загрузка WASM как модуля
let wasmModule: any;

function App() {
  const [result, setResult] = useState<string>('');

  const callGo = async (service: string) => {
    // Подготавливаем данные
    const data =
      service === 'python'
        ? { A: [[2, 1]], B: [[5], [7]] }  // A: 1x2, B: 2x1 → результат: 1x1
        : service === 'julia'
        ? { A: [[2, 3], [1, 4]], b: [5, 7] }  // A: 2x2, b: 2 → решение: 2x1
        : null;

    if (!data) {
      setResult(`Unknown service: ${service}`);
      return;
    }

    // URL для go-api
    const url =
      service === 'python'
        ? 'http://localhost:8080/python/multiply'
        : service === 'julia'
        ? 'http://localhost:8080/julia/solve'
        : '';

    if (!url) {
      setResult('Invalid service URL');
      return;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      // Читаем тело как текст один раз
      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error(`Invalid JSON response: ${text}`);
      }

      setResult(`${service} result: ${JSON.stringify(json)}`);
    } catch (err) {
      console.error('Error calling Go:', err);
      setResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runFibonacci = async () => {
  try {
    await loadScript('/rust-wasm/index.js', true);

    // Ждём, пока window.rust_wasm появится
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WASM timeout'));
      }, 5000);

      const check = setInterval(() => {
        if (window.rust_wasm) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve(true);
        }
      }, 50);
    });

    const fib = window.rust_wasm.fibonacci(35);
    setResult(`Fibonacci(35) = ${fib}`);
  } catch (err) {
    console.error('Error loading WASM:', err);
    setResult(`WASM Error: ${err instanceof Error ? err.message : String(err)}`);
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
      {result && (
        <pre style={{ marginTop: '20px', backgroundColor: '#f0f0f0', padding: '10px', borderRadius: '4px' }}>
          {result}
        </pre>
      )}
    </div>
  );
}

// Вспомогательная функция для загрузки скрипта
function loadScript(src: string, isModule = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    if (isModule) script.type = 'module';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}
export default App;