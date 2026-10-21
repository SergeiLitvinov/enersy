import { useState } from 'react';
import type { CalculationTopology } from '../../../api/calculation-topology';

const PAGE_SIZE = 50;
export function ResultTopology({ topology }: { topology?: CalculationTopology }) {
  const [page, setPage] = useState(0);
  if (!topology) return <p className="result-source-note">Эта версия расчётного сервиса не публикует соответствие терминалов узлам.</p>;
  const total = topology.terminals.length + topology.internal_nodes.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const current = Math.min(page, lastPage), first = current * PAGE_SIZE;
  const rows = Array.from({ length: Math.min(PAGE_SIZE, total - first) }, (_, offset) => {
    const index = first + offset;
    if (index < topology.terminals.length) {
      const t = topology.terminals[index];
      return <tr key={`t:${t.component_id}:${t.terminal}`}>
        <td title={t.component_type}>#{t.component_id}</td><td>Терминал T{t.terminal}</td>
        <td>{t.bus_id ?? '—'}</td><td>{t.bus_id === null ? 'Аппарат без связей · исключён' : 'Внешний терминал'}</td>
      </tr>;
    }
    const node = topology.internal_nodes[index - topology.terminals.length];
    return <tr key={`internal:${node.bus_id}`}>
      <td>#{node.component_id}</td><td>Внутренняя ЭДС</td><td>{node.bus_id}</td><td>Внутренний узел модели</td>
    </tr>;
  });
  return <details className="result-details result-topology">
    <summary>Оборудование и расчётные узлы · {total}</summary>
    <p className="result-source-note">Индексы узлов относятся к снимку этого расчёта. Внешние терминалы и внутренние узлы модели различаются; номер узла не является постоянным ID оборудования. Точки top/bottom источника обозначают один терминал T1.</p>
    <div className="results-table-wrap" role="region" aria-label="Карта терминалов и узлов" tabIndex={0}>
      <table className="results-table"><caption>Привязка результата к оборудованию</caption>
        <thead><tr><th>Объект</th><th>Точка</th><th>Узел</th><th>Участие в модели</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
    {total > PAGE_SIZE && <div className="result-topology-pages" role="group" aria-label="Страницы карты узлов">
      <button className="tool-btn" type="button" aria-label="Предыдущая страница карты узлов" disabled={current === 0} onClick={() => setPage(current - 1)}>Назад</button>
      <span role="status">{first + 1}–{Math.min(first + PAGE_SIZE, total)} из {total}</span>
      <button className="tool-btn" type="button" aria-label="Следующая страница карты узлов" disabled={current === lastPage} onClick={() => setPage(current + 1)}>Далее</button>
    </div>}
  </details>;
}
