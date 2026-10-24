import { backendLabel, type CalculationBackend } from '../../../api/compute-backends';
import type { CalculationExecution } from '../../../api/calculation-execution';

export function ResultBackend({ backend, execution }: { backend?: CalculationBackend; execution?: CalculationExecution }) {
  return <section aria-label="Вычислительный движок" className="result-details">
    <h4>Вычислительный движок</h4>
    {backend ? <>
      <p>{backendLabel(backend.id)} · {backend.version}</p>
      <p>Сборка Якобиана: {backend.jacobian === 'rust' ? 'Rust' : 'Julia'}. Линейный решатель: UMFPACK.</p>
      <details><summary>Версии и контрольные суммы</summary><dl>
        <dt>Julia</dt><dd>{backend.julia_version}</dd>
        {backend.julia_core_version && <><dt>Вычислительное ядро Julia</dt><dd>{backend.julia_core_version}</dd></>}
        {backend.library_sha256 && <><dt>Библиотека Rust · SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{backend.library_sha256}</dd></>}
        {backend.julia_core_sha256 && <><dt>Код Julia · SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{backend.julia_core_sha256}</dd></>}
        {backend.adapter_sha256 && <><dt>Адаптер · SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{backend.adapter_sha256}</dd></>}
      </dl></details>
    </> : <p>В этом результате вычислительный движок не указан.</p>}
    {execution && <p>{execution.max_time_ms === null ? 'Бюджет времени не задан' : `Бюджет времени: ${(execution.max_time_ms / 1000).toLocaleString('ru-RU')} с`} · проверка между этапами.</p>}
  </section>;
}
