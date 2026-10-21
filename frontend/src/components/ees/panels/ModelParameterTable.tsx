import { modelParameterRows, unlistedModelParameters, type ModelParameterSpec } from '../../../domain/model-parameters';
export function ModelParameterTable({ specs, values }: { specs: readonly ModelParameterSpec[]; values: Readonly<Record<string, string>> }) {
  const unlisted = unlistedModelParameters(specs, values);
  const requirements = { required: 'Обязательный', optional: 'Необязательный', conditional: 'По условию' };
  const kinds = { number: 'число', integer: 'целое', boolean: 'логический' };
  return <section className="model-parameters" aria-label="Параметры модели и объекта"><h4>Входные параметры модели</h4>
    <p>Значения объекта показаны как сохранены. Допущения ядра указаны отдельно и не записываются в объект. Полную проверку выполняет расчётный worker.</p>
    <div className="model-parameters-scroll"><table><caption>Сопоставление с контрактом текущего ядра</caption><thead><tr><th scope="col">Параметр</th><th scope="col">В объекте</th></tr></thead><tbody>{modelParameterRows(specs, values).map(({ spec, value, presence }) => <tr key={spec.key} className={spec.requirement === 'required' && presence !== 'stored' ? 'model-parameter-missing' : ''}>
      <th scope="row">{spec.name}<small>{spec.key} · {spec.unit === '1' ? 'безразмерная' : spec.unit} · {kinds[spec.kind]}</small><small>{requirements[spec.requirement]}</small></th>
      <td>{presence === 'missing' ? 'Не задано' : presence === 'empty' ? 'Пустое значение' : value}<small>{spec.note}</small>{spec.default_value !== null && <small>При отсутствии в модели: {spec.default_value}</small>}</td>
    </tr>)}</tbody></table></div>
    {unlisted.length > 0 && <details><summary>Параметры вне этого описания: {unlisted.length}</summary><p>Они сохранены в объекте. Этот список не определяет, использует ли их другой профиль или модель.</p>{unlisted.map(([key, value]) => <p key={key}><code>{key}</code>: {value.trim() ? value : 'Пустое значение'}</p>)}</details>}
  </section>;
}
