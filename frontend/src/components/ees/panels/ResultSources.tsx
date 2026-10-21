import type { CalculationSource } from '../../../api/ees-api';

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });
const optional = (value: number | undefined) => value === undefined ? 'Не передано' : number.format(value);

export function ResultSources({ sources, islandByBus, showIslands }: {
  sources?: CalculationSource[]; islandByBus: ReadonlyMap<number, number>; showIslands: boolean;
}) {
  if (!sources?.length) return null;
  return <section aria-label="Результаты источников">
    <div className="results-table-wrap" role="region" aria-label="Мощности источников" tabIndex={0}>
      <table className="results-table"><caption>Источники · внутренняя ЭДС и внешние выводы</caption>
        <thead><tr><th>Источник</th><th>Режим</th><th>P ЭДС, МВт</th><th>Q ЭДС, Мвар</th><th>P выводов, МВт</th><th>Q выводов, Мвар</th><th>ΔP, МВт</th><th>ΔQ, Мвар</th><th>Границы Q ЭДС, Мвар</th><th>Состояние Q ЭДС</th></tr></thead>
        <tbody>{sources.map(source => <tr key={source.component_id}>
          <td>Генератор #{source.component_id}<span className="result-source-node">Шина {source.terminal_bus}{showIslands && ` · Остров ${islandByBus.get(source.internal_bus)}`}</span></td>
          <td><span className="node-type">{source.type.toUpperCase()}</span></td>
          <td>{number.format(source.p_mw)}</td><td>{number.format(source.q_mvar)}</td>
          <td>{optional(source.terminal_p_mw)}</td><td>{optional(source.terminal_q_mvar)}</td>
          <td>{optional(source.losses_p_mw)}</td><td>{optional(source.losses_q_mvar)}</td>
          <td>{source.q_limits_applied && source.q_min_emf_mvar !== undefined && source.q_max_emf_mvar !== undefined ? `${number.format(source.q_min_emf_mvar)} … ${number.format(source.q_max_emf_mvar)}` : '—'}</td>
          <td><span className="q-limit-state" data-state={source.q_limit_status}>{source.q_limit_status === 'clamped' ? 'На границе' : source.q_limit_status === 'within_bounds' ? 'В диапазоне' : source.q_limit_status === 'not_declared' ? 'Не заданы' : 'Не применены'}</span></td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="result-source-note">P и Q ЭДС — выдача за внутренним сопротивлением, P и Q выводов — выдача во внешнюю сеть. Положительное значение означает генерацию, отрицательное — потребление. Разность — ΔP и ΔQ внутренней ветви; это не модель всех потерь машины. Границы Q действуют на внутренней ЭДС; терминальные ограничения пока не поддержаны. Для старых результатов отсутствующие величины не восстанавливаются.</p>
  </section>;
}
