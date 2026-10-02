import type { CalculationResult } from '../../../api/ees-api';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import './ResultsModal.css';
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });
export const ResultsModal = ({ result, schemeName, onClose }: { result: CalculationResult; schemeName: string; onClose: () => void }) => {
  const showIslands = (result.island_results?.length ?? 0) > 1;
  const islandByBus = new Map(result.island_results?.flatMap(island => island.bus_ids.map(id => [id, island.island_id] as const)));
  return <Dialog title="Результаты расчёта" onClose={onClose} wide>
  <div className="results-heading"><div><p className="eyebrow">Установившийся режим</p><h3>{schemeName}</h3></div><span className="capability-badge">{result.capability?.status === 'validated' ? 'Проверенный режим' : 'Экспериментальный результат'}</span></div>
  <div className="result-metrics"><div><span>Узлов</span><strong>{result.node_count}</strong></div><div><span>Итераций</span><strong>{result.iterations}</strong></div><div><span>Вычисление</span><strong>{number.format(result.computation_time_ms)} <small>мс</small></strong></div></div>
  {result.capability?.reasons?.length ? <div className="result-notice"><Icon name="alert" /><div><strong>Границы применимости</strong><ul>{result.capability.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div></div> : null}
  {result.island_results && result.island_results.length > 1 && <section aria-label="Питаемые острова">
    <div className="results-table-wrap" role="region" aria-label="Таблица островов" tabIndex={0}><table className="results-table"><caption>Независимые питаемые острова</caption>
      <thead><tr><th>Остров</th><th>Узлов</th><th>Балансирующий источник</th><th>Итераций</th><th>Невязка, p.u.</th></tr></thead>
      <tbody>{result.island_results.map(island => <tr key={island.island_id}>
        <td>{island.island_id}</td><td>{island.bus_ids.length}</td><td>Генератор #{island.slack_component}<span className="result-source-node">Опорный узел {island.slack_bus}</span></td>
        <td>{island.iterations}</td><td>{island.max_mismatch_pu.toExponential(2)}</td>
      </tr>)}</tbody></table></div>
    <p className="result-source-note">Каждый остров имеет свой опорный угол. Разность углов между несвязанными островами не задаёт физическое фазовое отношение.</p>
  </section>}
  <div className="results-table-wrap"><table className="results-table"><caption>Напряжения и углы электрических узлов</caption><thead><tr><th>Узел</th>{showIslands && <th>Остров</th>}<th>Тип</th><th>Напряжение, кВ</th><th>Угол, °</th></tr></thead><tbody>{result.nodes.map(node => <tr key={node.node_id}><td>{node.node_id}</td>{showIslands && <td>{islandByBus.get(node.node_id)}</td>}<td><span className="node-type">{node.node_type}</span></td><td>{number.format(node.voltage)}</td><td>{number.format(node.angle)}</td></tr>)}</tbody></table></div>
  {!!result.sources?.length && <section aria-label="Результаты источников">
    <div className="results-table-wrap"><table className="results-table"><caption>Источники · мощности внутренней ЭДС</caption>
      <thead><tr><th>Источник</th><th>Режим</th><th>P, МВт</th><th>Q, Мвар</th><th>Границы Q, Мвар</th><th>Состояние Q</th></tr></thead>
      <tbody>{result.sources.map(source => <tr key={source.component_id}>
        <td>Генератор #{source.component_id}<span className="result-source-node">Шина {source.terminal_bus}{showIslands && ` · Остров ${islandByBus.get(source.internal_bus)}`}</span></td>
        <td><span className="node-type">{source.type.toUpperCase()}</span></td>
        <td>{number.format(source.p_mw)}</td><td>{number.format(source.q_mvar)}</td>
        <td>{source.q_limits_applied && source.q_min_emf_mvar !== undefined && source.q_max_emf_mvar !== undefined ? `${number.format(source.q_min_emf_mvar)} … ${number.format(source.q_max_emf_mvar)}` : '—'}</td>
        <td><span className="q-limit-state" data-state={source.q_limit_status}>{source.q_limit_status === 'clamped' ? 'На границе' : source.q_limit_status === 'within_bounds' ? 'В диапазоне' : source.q_limit_status === 'not_declared' ? 'Не заданы' : 'Не применены'}</span></td>
      </tr>)}</tbody></table></div>
    <p className="result-source-note">P и Q относятся к внутренней ЭДС за сопротивлением. Мощности на выводах машины отличаются на потери этой ветви.</p>
  </section>}
  {!!result.warnings?.length && <details className="result-details" open><summary>Предупреждения · {result.warnings.length}</summary><ul>{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
  {!!result.assumptions?.length && <details className="result-details"><summary>Принятые допущения · {result.assumptions.length}</summary><ul>{result.assumptions.map((assumption, i) => <li key={i}>{assumption}</li>)}</ul></details>}
  <p className="dialog-intro">Метод: {result.method_used}. Наличие результата не заменяет независимую проверку физической модели.</p>
</Dialog>;
};
