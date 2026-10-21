import { useState } from 'react';
import type { CalculationBranch, CalculationShunt } from '../../../api/calculation-flows';

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 5 });
const label = { generator: 'Источник · внутреннее сопротивление', transmission_line: 'Линия', transformer: 'Трансформатор', capacitor: 'Конденсатор', reactor: 'Реактор' };
const PAGE_SIZE = 50;

export function ResultFlows({ branches, shunts }: { branches?: CalculationBranch[]; shunts?: CalculationShunt[] }) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil((branches?.length ?? 0) / PAGE_SIZE) - 1);
  const current = Math.min(page, last), start = current * PAGE_SIZE;
  return <section aria-label="Потоки мощности и шунты">
    {branches === undefined ? <p className="result-source-note">Сервис не предоставил потоки ветвей.</p> : <details className="result-details result-topology">
      <summary>Потоки ветвей · {branches.length}</summary>
      <p className="result-source-note">P и Q на каждом конце положительны при входе в элемент. Для линии и трансформатора начало — T1, конец — T2; для источника — внутренняя ЭДС и внешний T1. ΔP и ΔQ — суммы мощностей обоих концов с учётом поперечных ветвей модели. Отрицательная ΔQ допустима при ёмкостной выдаче. Токи — действующие значения, кА.</p>
      {branches.length === 0 ? <p className="result-source-note">В расчёте нет последовательных ветвей.</p> : <div className="results-table-wrap" role="region" aria-label="Потоки ветвей" tabIndex={0}>
        <table className="results-table result-flow-table"><caption>Мощности и токи на концах ветвей</caption>
          <thead><tr><th>Объект</th><th>Узлы: начало → конец</th><th>P нач., МВт</th><th>Q нач., Мвар</th><th>P кон., МВт</th><th>Q кон., Мвар</th><th>ΔP, МВт</th><th>ΔQ, Мвар</th><th>I нач., кА</th><th>I кон., кА</th></tr></thead>
          <tbody>{branches.slice(start, start + PAGE_SIZE).map(b => <tr key={b.component_id}>
            <td>#{b.component_id}<span className="result-source-node">{label[b.code]}</span>{b.code === 'transformer' && <span className="result-source-node">φ НН−ВН: {b.phase_shift_deg === undefined ? 'Не передано' : `${number.format(b.phase_shift_deg)}°`}</span>}</td><td>{b.from_bus} → {b.to_bus}</td>
            {[b.p_from_mw, b.q_from_mvar, b.p_to_mw, b.q_to_mvar, b.losses_p_mw, b.losses_q_mvar, b.i_from_ka, b.i_to_ka].map((value, i) => <td key={i}>{number.format(value)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>}
      {branches.length > PAGE_SIZE && <div className="result-topology-pages" role="group" aria-label="Страницы потоков ветвей">
        <button className="tool-btn" type="button" aria-label="Предыдущая страница потоков" disabled={current === 0} onClick={() => setPage(current - 1)}>Назад</button>
        <span role="status">{start + 1}–{Math.min(start + PAGE_SIZE, branches.length)} из {branches.length}</span>
        <button className="tool-btn" type="button" aria-label="Следующая страница потоков" disabled={current === last} onClick={() => setPage(current + 1)}>Далее</button>
      </div>}
    </details>}
    {shunts === undefined ? <p className="result-source-note">Сервис не предоставил результаты шунтов.</p> : <ShuntResults shunts={shunts} />}
  </section>;
}

function ShuntResults({ shunts }: { shunts: CalculationShunt[] }) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(shunts.length / PAGE_SIZE) - 1), current = Math.min(page, last), start = current * PAGE_SIZE;
  return <details className="result-details result-topology"><summary>Шунты · {shunts.length}</summary>
    <p className="result-source-note">P и Q — потребление при рассчитанном напряжении. Для конденсатора Q отрицательна, для реактора положительна. Паспортное Qном — положительный модуль при номинальном напряжении; фактическая мощность зависит от квадрата напряжения.</p>
    {shunts.length === 0 ? <p className="result-source-note">В расчёте нет шунтов оборудования.</p> : <div className="results-table-wrap" role="region" aria-label="Результаты шунтов" tabIndex={0}>
      <table className="results-table"><caption>Шунты при рассчитанном напряжении</caption><thead><tr><th>Объект</th><th>Узел</th><th>Qном, Мвар</th><th>P, МВт</th><th>Q, Мвар</th></tr></thead>
        <tbody>{shunts.slice(start, start + PAGE_SIZE).map(s => <tr key={s.component_id}><td>#{s.component_id}<span className="result-source-node">{label[s.code]}</span></td><td>{s.bus}</td><td>{number.format(s.q_nom_mvar)}</td><td>{number.format(s.p_mw)}</td><td>{number.format(s.q_mvar)}</td></tr>)}</tbody>
      </table></div>}
    {shunts.length > PAGE_SIZE && <div className="result-topology-pages" role="group" aria-label="Страницы шунтов">
      <button className="tool-btn" type="button" aria-label="Предыдущая страница шунтов" disabled={current === 0} onClick={() => setPage(current - 1)}>Назад</button>
      <span role="status">{start + 1}–{Math.min(start + PAGE_SIZE, shunts.length)} из {shunts.length}</span>
      <button className="tool-btn" type="button" aria-label="Следующая страница шунтов" disabled={current === last} onClick={() => setPage(current + 1)}>Далее</button>
    </div>}
  </details>;
}
