import React, { useState, useRef } from 'react';
import SchemeEditor from './components/ees/SchemeEditor';
import './App.css';
import { Icon } from './components/ui/Icon';
import { ComponentWrites } from './components/ees/component-writes';

function App() {
  const [activeTab, setActiveTab] = useState<'ees' | 'legacy'>('ees');
  const writeQueue = useRef(new ComponentWrites());

  return (
    <div className="app">
      <header className="app-header">
        <a className="app-brand" href="/" aria-label="Enersy — рабочее пространство"><span className="brand-mark"><Icon name="grid" /></span><span>Enersy <small>Power system studio</small></span></a>
        <nav className="app-nav">
          <button
            className={`nav-btn ${activeTab === 'ees' ? 'active' : ''}`}
            onClick={() => setActiveTab('ees')}
          >
            <Icon name="grid" /> Рабочее пространство
          </button>
          <button
            className={`nav-btn ${activeTab === 'legacy' ? 'active' : ''}`}
            onClick={() => setActiveTab('legacy')}
          >
            <Icon name="link" /> Диагностика API
          </button>
        </nav>
        <a className="header-help" aria-label="Руководство" href="http://localhost:4173/" target="_blank" rel="noreferrer"><Icon name="book" /><span>Руководство</span></a>
      </header>

      <main className="app-main">
        {activeTab === 'ees' ? (
          <SchemeEditor writeQueue={writeQueue.current} />
        ) : (
          <LegacyAPI />
        )}
      </main>
    </div>
  );
}

// Legacy API компонент для тестирования старых endpoints
const LegacyAPI: React.FC = () => {
  const API_BASE = '';
  const [result, setResult] = useState<string>('');

  const callAPI = async (endpoint: string, data?: unknown) => {
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      setResult(JSON.stringify(json, null, 2));
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="legacy-api">
      <p className="eyebrow">Инструменты разработчика</p><h2>Диагностика сервисов</h2><p>Проверка соединения и контрактов. Решение СЛАУ не является расчётом режима сети.</p>

      <div className="api-buttons">
        <button onClick={() => callAPI('/julia/solve', { A: [[2, 3], [1, 4]], b: [5, 7] })}>
          Julia: Решение СЛАУ
        </button>
        <button onClick={() => callAPI('/api/ees/component-types')}>
          EES: Типы компонентов
        </button>
        <button onClick={() => callAPI('/api/ees/capabilities')}>
          Возможности расчёта
        </button>
      </div>

      {result && (
        <pre className="api-result">{result}</pre>
      )}
    </div>
  );
};

export default App;
