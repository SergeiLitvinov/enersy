import { useState, type ReactNode } from 'react';
import type { ArchiveInput } from '../../api/calculation-archives-api';
import type { CalculationProvenance } from '../../api/calculation-provenance';
import { ArchiveProvenance } from './ArchiveProvenance';
const typeNames: Record<string, string> = { generator: 'Источник', transmission_line: 'Линия', load: 'Нагрузка', transformer: 'Трансформатор', breaker: 'Выключатель', disconnector: 'Разъединитель', busbar: 'Сборная шина', capacitor: 'Конденсатор', reactor: 'Реактор' };
function Rows<T>({ rows, title, headers, render }: { rows: readonly T[]; title: string; headers: string[]; render: (row: T, index: number) => ReactNode }) {
  const [page, setPage] = useState(0), last = Math.max(0, Math.ceil(rows.length / 50) - 1);
  const current = Math.min(page, last), start = current * 50;
  return <><div className="results-table-wrap" role="region" aria-label={title} tabIndex={0}><table className="results-table"><caption>{title}</caption><thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.slice(start, start + 50).map((r, i) => render(r, start + i))}</tbody></table></div>
    {rows.length > 50 && <div className="result-topology-pages"><button className="tool-btn" disabled={!current} onClick={() => setPage(current - 1)} aria-label={`Назад: ${title}`}>Назад</button><span role="status">{start + 1}–{Math.min(start + 50, rows.length)} из {rows.length}</span><button className="tool-btn" disabled={current === last} onClick={() => setPage(current + 1)} aria-label={`Далее: ${title}`}>Далее</button></div>}</>;
}
export function ArchiveInputs({ input, provenance }: { input: ArchiveInput; provenance?: CalculationProvenance }) {
  const [selected, select] = useState<number | null>(null), component = input.components.find(c => c.id === selected);
  return <details className="result-details result-topology archive-inputs"><summary>Исходные данные · {input.components.length} объектов · {input.connections.length} связей</summary>
    <p className="result-source-note">Захваченные параметры, геометрия и соединения. Значения из текущего каталога и текущей схемы сюда не подставляются. Выберите объект для просмотра параметров.</p>
    <Rows title="Оборудование снимка" headers={['Объект', 'Тип', 'Координаты на холсте', 'Поворот, °']} rows={input.components} render={c => <tr key={c.id}><td><button className="tool-btn" aria-pressed={selected === c.id} onClick={() => select(c.id)}>Объект №{c.id}</button></td><td title={c.type}>{Object.prototype.hasOwnProperty.call(typeNames, c.type) ? typeNames[c.type] : c.type}</td><td>{c.x}; {c.y}</td><td>{c.rotation}</td></tr>} />
    {component && <><ArchiveProvenance source={provenance?.components.find(c => c.id === String(component.id))} params={component.params} /><Rows key={component.id} title={`Параметры объекта №${component.id}`} headers={['Параметр', 'Захваченное значение']} rows={Object.entries(component.params)} render={([key, value]) => <tr key={key}><th scope="row">{key}</th><td>{value || 'Пустая строка'}</td></tr>} /></>}
    <Rows title="Соединения снимка" headers={['От объекта', 'Порт начала', 'К объекту', 'Порт конца']} rows={input.connections} render={(c, i) => <tr key={i}><td>№{c.from}</td><td>{c.fromPort}</td><td>№{c.to}</td><td>{c.toPort}</td></tr>} />
  </details>;
}
