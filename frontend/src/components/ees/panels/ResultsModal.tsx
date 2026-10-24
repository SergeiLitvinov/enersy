import type { CalculationResult } from '../../../api/ees-api';
import type { ReactNode } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { ResultTopology } from './ResultTopology';
import { ResultFlows } from './ResultFlows';
import { ResultLoads } from './ResultLoads';
import { ResultSources } from './ResultSources';
import { ResultBackend } from './ResultBackend';
import { ResultOperatingAssessment } from './ResultOperatingAssessment';
import './ResultsModal.css';
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });
export const ResultsModal = ({ result, schemeName, onClose, context }: { result: CalculationResult; schemeName: string; onClose: () => void; context?: ReactNode }) => {
  const showIslands = (result.island_results?.length ?? 0) > 1;
  const islandByBus = new Map(result.island_results?.flatMap(island => island.bus_ids.map(id => [id, island.island_id] as const)));
  return <Dialog title="Результаты расчёта" onClose={onClose} wide>
  {context}
  <div className="results-heading"><div><p className="eyebrow">Установившийся режим</p><h3>{schemeName}</h3></div><span className="capability-badge">{result.capability?.status === 'validated' ? 'Проверенный режим' : 'Экспериментальный результат'}</span></div>
  <div className="result-metrics"><div><span>Узлов</span><strong>{result.node_count}</strong></div><div><span>Итераций</span><strong>{result.iterations}</strong></div><div><span>Вычисление</span><strong>{number.format(result.computation_time_ms)} <small>мс</small></strong></div></div>
  <ResultBackend backend={result.solver?.compute_backend} execution={result.solver?.execution} />
  <ResultOperatingAssessment assessment={result.operating_assessment} />
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
  <ResultTopology topology={result.topology} />
  <ResultFlows branches={result.branches} shunts={result.shunts} />
  <ResultLoads loads={result.loads} />
  <ResultSources sources={result.sources} islandByBus={islandByBus} showIslands={showIslands} />
  {!!result.warnings?.length && <details className="result-details" open><summary>Предупреждения · {result.warnings.length}</summary><ul>{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
  {!!result.assumptions?.length && <details className="result-details"><summary>Принятые допущения · {result.assumptions.length}</summary><ul>{result.assumptions.map((assumption, i) => <li key={i}>{assumption}</li>)}</ul></details>}
  <p className="dialog-intro">Метод: {result.method_used}. Наличие результата не заменяет независимую проверку физической модели.</p>
</Dialog>;
};
