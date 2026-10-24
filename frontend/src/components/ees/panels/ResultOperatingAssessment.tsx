import type { OperatingAssessment } from '../../../api/operating-assessment';

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });
const labels = { below_min: 'Ниже минимума', above_max: 'Выше максимума', within_bounds: 'В границах' };
export function ResultOperatingAssessment({ assessment }: { assessment?: OperatingAssessment }) {
  const status = !assessment ? 'В этом результате оценка ограничений не сохранена.' :
    assessment.status === 'not_declared' ? 'Режимные ограничения не заданы.' :
    assessment.status === 'violated' ? 'Есть нарушения заданных границ напряжения.' : 'Напряжения находятся в заданных границах.';
  return <section aria-label="Режимные ограничения" className="result-details">
    <h4>Режимные ограничения</h4><p>{status}</p>
    <p className="dialog-intro">Сходимость не подтверждает допустимость или устойчивость режима. Проверка относится только к явно заданным границам; устойчивость не оценивалась.</p>
    {!!assessment?.checks.length && <div className="results-table-wrap" role="region" aria-label="Проверка границ напряжения" tabIndex={0}>
      <table className="results-table"><caption>Линейные действующие напряжения · кВ</caption>
        <thead><tr><th>Объект / терминал</th><th>Узел</th><th>Минимум</th><th>Расчёт</th><th>Максимум</th><th>Состояние</th></tr></thead>
        <tbody>{assessment.checks.map(c => <tr key={`${c.component_id}/${c.terminal}`}>
          <td>#{c.component_id} / {c.terminal}</td><td>{c.bus_id}</td><td>{number.format(c.min)}</td>
          <td>{number.format(c.measured)}</td><td>{number.format(c.max)}</td><td>{labels[c.status]}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
