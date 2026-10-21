import { useEffect, useState } from 'react';
import type { PassportVersion } from '../../../api/project-passports-api';
import type { SchemeTransport } from '../scheme-transport';
import type { ComponentParam } from '../../../api/ees-api';

export function ProjectPassportPicker({ read, typeCode, selected, onSelect, disabled, template }: {
  read: NonNullable<SchemeTransport['projectPassports']>; typeCode: string;
  selected: PassportVersion | null; onSelect: (version: PassportVersion) => void; disabled: boolean;
  template: ComponentParam[];
}) {
  const [after, setAfter] = useState('');
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<{ cursor: string; items: PassportVersion[]; next: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setPage(undefined); setError('');
    read(controller.signal, after).then(result => {
      if (active) setPage({ cursor: after, items: result.items, next: result.nextAfterId });
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : 'Не удалось загрузить паспорта проекта'); });
    return () => { active = false; controller.abort(); };
  }, [read, after, retry]);
  const current = page?.cursor === after ? page : undefined;
  const matching = current?.items.filter(item => item.document.componentTypeCode === typeCode) ?? [];
  return <div className="passport-layout">
    <section className="passport-browser" aria-label="Паспорта проекта">
      <p>Каждая строка — сохранённая версия. Обновление каталога не заменяет выбранную версию.</p>
      {!current && !error && <p role="status">Загрузка паспортов проекта…</p>}
      {error && <div role="alert"><p>{error}</p><button className="tool-btn" disabled={disabled} onClick={() => setRetry(n => n + 1)}>Повторить загрузку паспортов</button></div>}
      {current && <>
        <div className="passport-options">{matching.map(item => <label key={item.id} className={`passport-option ${selected?.id === item.id ? 'is-selected' : ''}`}>
          <input type="radio" name="project-passport" checked={selected?.id === item.id} disabled={disabled} onChange={() => onSelect(item)} />
          <span><strong>{item.document.name}</strong><small>Версия {item.revision} · #{item.id} · Черновик</small><span>{item.document.manufacturer || 'Производитель не указан'}</span></span>
        </label>)}</div>
        {!matching.length && <p className="passport-empty">На этой странице нет паспортов выбранного типа.</p>}
        <div className="dialog-actions">
          {after && <button className="tool-btn" disabled={disabled} onClick={() => setAfter('')}>К первой странице</button>}
          {current.next && <button className="tool-btn" disabled={disabled} onClick={() => setAfter(current.next)}>Следующие паспорта</button>}
        </div>
      </>}
    </section>
    <section className="passport-preview" aria-label="Выбранная версия проекта">
      {!selected ? <p className="passport-empty">Выберите версию паспорта этого типа оборудования.</p> : <>
        <div className="passport-heading"><span>ПАСПОРТ ПРОЕКТА · ЧЕРНОВИК</span><h3>{selected.document.name}</h3><p>Версия {selected.revision} · #{selected.id}</p></div>
        <p>Источник: {selected.document.source}</p><p>Условия использования: {selected.document.license}</p>
        <p className="passport-provenance">На схему будет скопирован этот набор значений. Черновик не подтверждает полноту данных для расчёта; отсутствующие параметры не подставляются.</p>
        <div className="passport-table-wrap"><table className="passport-table"><caption>Параметры выбранной версии</caption><thead><tr><th scope="col">Параметр</th><th scope="col">Значение</th><th scope="col">Единица паспорта</th></tr></thead><tbody>
          {Object.entries(selected.document.parameters).map(([key, parameter]) => <tr key={key}><th scope="row">{template.find(item => item.key === key)?.name || key}</th><td>{parameter.value}</td><td>{parameter.unit || 'Не указана'}</td></tr>)}
        </tbody></table></div>
      </>}
    </section>
  </div>;
}
