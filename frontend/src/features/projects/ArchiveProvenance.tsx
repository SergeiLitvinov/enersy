import type { ComponentProvenance } from '../../api/calculation-provenance';

export function ArchiveProvenance({ source, params }: { source?: ComponentProvenance; params: Record<string, string> }) {
  if (!source) return <p className="result-source-note">Происхождение паспорта в этом архиве не сохранено. Текущий каталог не используется для его восстановления.</p>;
  const passport = source.passport;
  return <section aria-label="Происхождение параметров">
    <p>{source.name || 'Без названия'} · ревизия объекта {source.revision}.</p>
    {!passport ? <p>{source.source === 'legacy-catalog' ? `Общий справочник №${source.equipmentModelId}. Версия исходного паспорта не фиксировалась.` : 'Параметры экземпляра без привязки к паспорту.'}</p> : <>
      <h4>{passport.document.name} · версия {passport.revision} · №{passport.versionId}</h4>
      <p>Источник: {passport.document.source}</p><p>Условия использования: {passport.document.license}</p>
      <p className="result-source-note">Сравнение сохранённых строк на момент расчёта. Оно показывает отличия от паспорта, но не историю редактирования. Единицы относятся к исходному паспорту; единицы новых параметров здесь не восстанавливаются.</p>
      <div className="results-table-wrap"><table className="results-table"><caption>Паспорт и фактические параметры снимка</caption><thead><tr><th>Параметр</th><th>В паспорте</th><th>Единица паспорта</th><th>В расчётном снимке</th><th>Сравнение</th></tr></thead><tbody>
        {[...new Set([...Object.keys(passport.document.parameters), ...Object.keys(params)])].sort().map(key => {
          const original = Object.prototype.hasOwnProperty.call(passport.document.parameters,key) ? passport.document.parameters[key] : undefined;
          const actual = Object.prototype.hasOwnProperty.call(params,key) ? params[key] : undefined;
          return <tr key={key}><th scope="row">{key}</th><td>{original?.value ?? 'Не задано'}</td><td>{original?.unit || 'Не указана'}</td><td>{actual === undefined ? 'Не задано' : actual === '' ? 'Пустая строка' : actual}</td><td>{actual === undefined ? 'Отсутствует в экземпляре' : !original ? 'Дополнено в экземпляре' : actual === original.value ? 'Совпадает с паспортом' : 'Отличается от паспорта'}</td></tr>;
        })}
      </tbody></table></div>
    </>}
  </section>;
}
