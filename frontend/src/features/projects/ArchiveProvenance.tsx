import type { ComponentProvenance } from '../../api/calculation-provenance';
import { CapturedUnitLabel } from './CapturedUnitLabel';
import './ArchiveProvenance.css';
import { parameterSourceBase, type ParameterUnitDeclaration } from '../../api/parameter-unit-declaration';
import { parameterBaseLabel, sameParameterBase } from '../../domain/parameter-base';

export function ArchiveProvenance({ source, params, parameterUnits, declaration }: { source?: ComponentProvenance; params: Record<string, string>; parameterUnits?: Readonly<Record<string, string>>; declaration?: ParameterUnitDeclaration }) {
  if (!source) return <p className="result-source-note">Происхождение паспорта в этом архиве не сохранено. Текущий каталог не используется для его восстановления.</p>;
  const passport = source.passport;
  return <section aria-label="Происхождение параметров">
    <p>{source.name || 'Без названия'} · ревизия объекта {source.revision}.</p>
    {!passport ? <p>{source.source === 'legacy-catalog' ? `Общий справочник №${source.equipmentModelId}. Версия исходного паспорта не фиксировалась.` : 'Параметры экземпляра без привязки к паспорту.'}</p> : <>
      <h4>{passport.document.name} · версия {passport.revision} · №{passport.versionId}</h4>
      <p>Источник: {passport.document.source}</p><p>Условия использования: {passport.document.license}</p>
      <p className="result-source-note">Строки значений и обозначения единиц сравниваются отдельно. Это не пересчёт величин, проверка физической эквивалентности или история редактирования. Отсутствующие единицы снимка не заимствуются из паспорта или текущего каталога.</p>
      <div className="results-table-wrap"><table className="results-table archive-provenance-table"><caption>Паспорт и фактические параметры снимка</caption><thead><tr><th>Параметр</th><th>Паспорт: значение и единица</th><th>Снимок: значение и единица</th><th>Сравнение строк</th></tr></thead><tbody>
        {[...new Set([...Object.keys(passport.document.parameters), ...Object.keys(params)])].sort().map(key => {
          const original = Object.prototype.hasOwnProperty.call(passport.document.parameters,key) ? passport.document.parameters[key] : undefined;
          const actual = Object.prototype.hasOwnProperty.call(params,key) ? params[key] : undefined;
          const unit = parameterUnits && Object.prototype.hasOwnProperty.call(parameterUnits,key) ? parameterUnits[key] : undefined;
          const valueStatus = actual === undefined ? 'Отсутствует в экземпляре' : !original ? 'Дополнено в экземпляре' : actual === original.value ? 'Строки значений совпадают' : 'Строки значений различаются';
          const unitStatus = actual === undefined || !original ? undefined : unit === undefined ? 'Единица в снимке не сохранена' : unit === original.unit ? 'Обозначения единиц совпадают' : 'Обозначения единиц различаются';
          const basis = parameterSourceBase(declaration,key);
          const baseStatus = actual !== undefined && original?.unit === 'p.u.' && unit === 'p.u.'
            ? !original.base ? 'Исходный базис паспорта не сохранён' : !basis ? 'Базис в снимке не сохранён' : sameParameterBase(original.base,basis) ? 'Исходные базисы совпадают' : 'Исходные базисы различаются' : undefined;
          return <tr key={key}><th scope="row">{key}</th>
            <td><span>{original ? original.value === '' ? 'Пустая строка' : original.value : 'Не задано'}</span>{original && <small><CapturedUnitLabel value={original.unit} /></small>}{original?.unit === 'p.u.' && <small>{parameterBaseLabel(original.base)}</small>}</td>
            <td><span>{actual === undefined ? 'Не задано' : actual === '' ? 'Пустая строка' : actual}</span>{actual !== undefined && <small><CapturedUnitLabel value={unit} /></small>}{actual !== undefined && unit === 'p.u.' && <small>{parameterBaseLabel(basis)}</small>}</td>
            <td><span>{valueStatus}</span>{unitStatus && <small>{unitStatus}</small>}{baseStatus && <small>{baseStatus}</small>}</td></tr>;
        })}
      </tbody></table></div>
    </>}
  </section>;
}
