import type { CalculationResult } from '../../../api/ees-api';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import './ResultsModal.css';
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });
export const ResultsModal = ({ result, schemeName, onClose }: { result: CalculationResult; schemeName: string; onClose: () => void }) => <Dialog title="Результаты расчёта" onClose={onClose} wide>
  <div className="results-heading"><div><p className="eyebrow">Установившийся режим</p><h3>{schemeName}</h3></div><span className="capability-badge">{result.capability?.status === 'validated' ? 'Проверенный режим' : 'Экспериментальный результат'}</span></div>
  <div className="result-metrics"><div><span>Узлов</span><strong>{result.node_count}</strong></div><div><span>Итераций</span><strong>{result.iterations}</strong></div><div><span>Вычисление</span><strong>{number.format(result.computation_time_ms)} <small>мс</small></strong></div></div>
  {result.capability?.reasons?.length ? <div className="result-notice"><Icon name="alert" /><div><strong>Границы применимости</strong><ul>{result.capability.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div></div> : null}
  <div className="results-table-wrap"><table className="results-table"><caption>Напряжения и углы электрических узлов</caption><thead><tr><th>Узел</th><th>Тип</th><th>Напряжение, кВ</th><th>Угол, °</th></tr></thead><tbody>{result.nodes.map(node => <tr key={node.node_id}><td>{node.node_id}</td><td><span className="node-type">{node.node_type}</span></td><td>{number.format(node.voltage)}</td><td>{number.format(node.angle)}</td></tr>)}</tbody></table></div>
  {!!result.warnings?.length && <details className="result-details" open><summary>Предупреждения · {result.warnings.length}</summary><ul>{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
  {!!result.assumptions?.length && <details className="result-details"><summary>Принятые допущения · {result.assumptions.length}</summary><ul>{result.assumptions.map((assumption, i) => <li key={i}>{assumption}</li>)}</ul></details>}
  <p className="dialog-intro">Метод: {result.method_used}. Наличие результата не заменяет независимую проверку физической модели.</p>
</Dialog>;
