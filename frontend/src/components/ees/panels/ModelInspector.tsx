import { useEffect, useState } from 'react';
import { getModelDefinitions, type ModelDefinition, type ModelDefinitions, type ModelEdge, type ModelNode } from '../../../api/model-definitions';
import './ModelInspector.css';
import { ModelParameterTable } from './ModelParameterTable';
import { Dialog } from '../../ui/Dialog';

function IdealTransformer({ a, b, label }: { a: ModelNode; b: ModelNode; label: string }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy), half = Math.min(28, length / 3);
  const ux = dx / length, uy = dy / length;
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
  const vertical = Math.abs(dy) > Math.abs(dx);
  return <g data-model-symbol="transformer">
    <line x1={a.x} y1={a.y} x2={x - half * ux} y2={y - half * uy} />
    <line x1={x + half * ux} y1={y + half * uy} x2={b.x} y2={b.y} />
    <g transform={`translate(${x} ${y}) rotate(${Math.atan2(dy, dx) * 180 / Math.PI}) scale(${half / 28})`}>
      <circle cx="-10" cy="0" r="18" className="model-transformer-winding" />
      <circle cx="10" cy="0" r="18" className="model-transformer-winding" />
    </g>
    <text x={vertical ? x + 24 : x} y={vertical ? y + 4 : y + 34} textAnchor={vertical ? 'start' : 'middle'}>{label}</text>
  </g>;
}

function PassiveBranch({ a, b, edge }: { a: ModelNode; b: ModelNode; edge: ModelEdge }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy), half = Math.min(24, length / 3);
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
  const ux = dx / length, uy = dy / length;
  const vertical = Math.abs(dy) > Math.abs(dx);
  return <g data-model-symbol={edge.symbol}>
    <line x1={a.x} y1={a.y} x2={x - half * ux} y2={y - half * uy} />
    <line x1={x + half * ux} y1={y + half * uy} x2={b.x} y2={b.y} />
    <g transform={`translate(${x} ${y}) rotate(${Math.atan2(dy, dx) * 180 / Math.PI}) scale(${half / 24})`}>
      <path className="model-passive-symbol" d={edge.symbol === 'inductor'
        ? 'M-24 0 A6 6 0 0 1 -12 0 A6 6 0 0 1 0 0 A6 6 0 0 1 12 0 A6 6 0 0 1 24 0'
        : 'M-24 0 H-4 M-4 -14 V14 M4 -14 V14 M4 0 H24'} />
    </g>
    <text x={vertical ? x + 18 : x} y={vertical ? y + 4 : y + 24} textAnchor={vertical ? 'start' : 'middle'}>{edge.label}</text>
  </g>;
}
export function ModelDiagram({ model }: { model: ModelDefinition }) {
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  return <svg viewBox="0 0 360 210" className="model-diagram" role="img" aria-label={`Структура модели: ${model.name}`}>
    <title>{model.name} · символическая структура, без расчётных значений</title>
    {model.edges.map(edge => { const a = nodes.get(edge.from)!, b = nodes.get(edge.to)!; const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      if (edge.kind === 'transformer') return <IdealTransformer key={edge.id} a={a} b={b} label={edge.label} />;
      if (edge.symbol) return <PassiveBranch key={edge.id} a={a} b={b} edge={edge} />;
      return <g key={edge.id}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        {edge.kind === 'source' ? <circle cx={x} cy={y} r="17" className="model-element" /> : <rect x={x - 27} y={y - 14} width="54" height="28" rx={edge.kind === 'pq' ? 10 : 0} className="model-element" />}
        <text x={x} y={y + 4} textAnchor="middle">{edge.label}</text>
      </g>;
    })}
    {model.nodes.map(node => <g key={node.id}><circle cx={node.x} cy={node.y} r={node.terminal ? 4 : 2.5} /><text x={node.x} y={node.y + (node.y > 120 ? 22 : -13)} textAnchor="middle">{node.terminal ? `T${node.terminal}` : node.label}</text></g>)}
  </svg>;
}
export function ModelInspector({ equipmentType, active, params = {} }: { equipmentType: string; active: boolean; params?: Readonly<Record<string, string>> }) {
  const [state, setState] = useState<{type: string; data?: ModelDefinitions; error?: string}>({ type: equipmentType });
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    setExpanded(null);
    if (!active) return;
    const controller = new AbortController(); let current = true; setState({ type: equipmentType });
    getModelDefinitions(controller.signal).then(data => { if (current) setState({ type: equipmentType, data }); })
      .catch(error => { if (current) setState({ type: equipmentType, error: error instanceof Error ? error.message : 'Не удалось загрузить описания моделей' }); });
    return () => { current = false; controller.abort(); };
  }, [equipmentType, active, retry]);
  const data = state.type === equipmentType ? state.data : undefined;
  const error = state.type === equipmentType ? state.error : undefined;
  const model = data?.definitions.find(item => item.equipment_type === equipmentType);
  return <section className="model-inspector" aria-label="Математическая модель">
    <h3>Модель текущего ядра</h3>
    <p>Символическая структура реализации AC-режима. Это не результат компиляции вашей схемы и не сохранённая привязка исследования.</p>
    {error ? <div role="alert"><p>{error}</p><button className="tool-btn" onClick={() => setRetry(n => n + 1)}>Повторить загрузку моделей</button></div> : !data ? <p role="status">Загрузка описаний моделей…</p> : !model ? <p role="status">Для типа «{equipmentType}» описание ещё не опубликовано. Это не определяет поддержку расчёта; её проверяет worker.</p> : <>
      <h4>{model.name}</h4><p className="model-state">Статус режима: {data.status} · Julia {data.kernel_version}</p>
      <ModelDiagram model={model} />
      <button className="tool-btn" onClick={() => setExpanded(model.id)}>Развернуть модель</button>
      {active && expanded === model.id && <Dialog title={`Структура: ${model.name}`} onClose={() => setExpanded(null)} wide><p className="dialog-intro">Символическое представление текущей реализации. Значения вашей схемы здесь не рассчитываются.</p><ModelDiagram model={model} /><div className="model-equations">{model.equations.map(equation => <p key={equation}>{equation}</p>)}</div><p>Опорный потенциал не добавляет физический заземлитель.</p></Dialog>}
      <p className="model-reference-note">Опорный потенциал на рисунке не добавляет физический заземлитель.</p>
      <div className="model-equations">{model.equations.map(equation => <p key={equation}>{equation}</p>)}</div>
      {model.parameters ? <ModelParameterTable specs={model.parameters} values={params} /> : <p>Эта версия worker не публикует контракт параметров.</p>}
      <ul>{model.limitations.map(item => <li key={item}>{item}</li>)}</ul>
      <details><summary>Исходники и идентичность реализации</summary><p>ID: {model.id}</p><p>Реализация: {model.implementation}</p><p>Режим: {data.model_group} / {data.method}</p><p>SHA-256 комплекта исходников: <code>{data.source_revision}</code></p>{data.source_files.map(file => <p key={file.path}><code>{file.path}</code><small>{file.sha256}</small></p>)}</details>
    </>}
  </section>;
}
