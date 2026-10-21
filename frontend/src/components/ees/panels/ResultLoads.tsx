import { useState } from 'react';
import type { CalculationLoad } from '../../../api/calculation-loads';
const format = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 5 });
const SIZE = 50;

export function ResultLoads({ loads }: { loads?: readonly CalculationLoad[] }) {
  const [page, setPage] = useState(0);
  if (loads === undefined) return <p className="result-source-note">В этом результате нет отдельных сведений о нагрузках.</p>;
  const last = Math.max(0, Math.ceil(loads.length / SIZE) - 1), current = Math.min(page, last), start = current * SIZE;
  return <section aria-label="Результаты нагрузок"><details className="result-details result-topology">
    <summary>Нагрузки · {loads.length}</summary>
    <p className="result-source-note">Положительные P и Q — потребление, отрицательные — выдача. Для ZIP номинальные мощности заданы при Uном; фактические зависят от рассчитанного напряжения. Для PQ мощность постоянна. Это статическая модель без динамики двигателя.</p>
    {loads.length === 0 ? <p>В расчёте нет нагрузок.</p> : <div className="results-table-wrap" role="region" aria-label="Мощности нагрузок" tabIndex={0}>
      <table className="results-table"><caption>Фактическое и номинальное потребление нагрузок</caption><thead><tr><th>Объект</th><th>Узел</th><th>Профиль</th><th>U, кВ</th><th>Uном, кВ</th><th>P, МВт</th><th>Q, Мвар</th><th>Pном, МВт</th><th>Qном, Мвар</th></tr></thead><tbody>
        {loads.slice(start, start + SIZE).map(load => <tr key={load.component_id}><td>Нагрузка #{load.component_id}</td><td>{load.bus}</td><td>{load.profile.toUpperCase()}</td>
          <td>{format.format(load.voltage_kv)}</td><td>{load.voltage_nom_kv == null ? 'Не передано' : format.format(load.voltage_nom_kv)}</td>
          {[load.p_mw, load.q_mvar, load.p_nom_mw, load.q_nom_mvar].map((value, index) => <td key={index}>{format.format(value)}</td>)}
        </tr>)}
      </tbody></table></div>}
    {loads.length > SIZE && <div className="result-topology-pages" role="group" aria-label="Страницы нагрузок">
      <button type="button" className="tool-btn" disabled={current === 0} onClick={() => setPage(current - 1)}>Назад</button>
      <span role="status">{start + 1}–{Math.min(start + SIZE, loads.length)} из {loads.length}</span>
      <button type="button" className="tool-btn" disabled={current === last} onClick={() => setPage(current + 1)}>Далее</button>
    </div>}
  </details></section>;
}
