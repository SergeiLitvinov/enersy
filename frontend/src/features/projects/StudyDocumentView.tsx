import type { StudyDocument } from '../../api/studies-api';
import { backendLabel } from '../../api/compute-backends';

export function StudyDocumentView({ document }: { document: StudyDocument }) {
  return <div className="study-document">
    <dl className="study-facts">
      <div><dt>Профиль</dt><dd>Симметричный AC · Ньютон–Рафсон</dd></div>
      <div><dt>Движок</dt><dd>{backendLabel(document.computeBackend)}</dd></div>
      <div><dt>Базис мощности</dt><dd>{document.base.s_base_mva.toLocaleString('ru-RU')} МВА</dd></div>
      <div><dt>Базис напряжения</dt><dd>{document.base.v_base_kv.toLocaleString('ru-RU')} кВ · линейное RMS</dd></div>
      <div><dt>Допуск невязки</dt><dd>{document.solverOptions.tolerance} p.u.</dd></div>
      <div><dt>Лимит итераций</dt><dd>{document.solverOptions.max_iterations}</dd></div>
      <div><dt>Мягкий бюджет времени</dt><dd>{document.maxTimeMs.toLocaleString('ru-RU')} мс</dd></div>
    </dl>
    {document.operatingLimits.length ? <div className="results-table-wrap" role="region" aria-label="Границы исследования" tabIndex={0}>
      <table className="results-table"><caption>Границы линейного действующего напряжения · кВ</caption>
        <thead><tr><th>Объект / терминал</th><th>Минимум</th><th>Максимум</th></tr></thead>
        <tbody>{document.operatingLimits.map(l => <tr key={`${l.component_id}/${l.terminal}`}><td>#{l.component_id} / {l.terminal}</td><td>{l.min_kv}</td><td>{l.max_kv}</td></tr>)}</tbody>
      </table>
    </div> : <p className="projects-note">Границы напряжения не заданы.</p>}
  </div>;
}
