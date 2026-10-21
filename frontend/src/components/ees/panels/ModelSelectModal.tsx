import { useEffect, useRef, useState } from 'react';
import * as api from '../../../api/ees-api';
import { passportRows } from '../../../features/catalog/passport-comparison';
import { Dialog } from '../../ui/Dialog';
import './ModelSelectModal.css';
import type { SchemeTransport } from '../scheme-transport';
import type { PassportVersion } from '../../../api/project-passports-api';
import { ProjectPassportPicker } from './ProjectPassportPicker';
interface ModelSelectModalProps {
  componentType: { id: number; code: string; name: string };
  onConfirm: (equipmentModelId: number | null, projectPassportVersionId?: string) => Promise<void>;
  projectPassports?: SchemeTransport['projectPassports'];
  onCancel: () => void;
}
function usePassport(id: number | null) {
  const [state, setState] = useState<{ id: number | null; params?: Record<string, string>; error?: string }>({ id: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setState({ id });
    if (id !== null) api.getEquipmentModelParams(id, controller.signal).then(params => {
      if (active) setState({ id, params });
    }).catch(() => { if (active) setState({ id, error: 'Не удалось загрузить параметры паспорта.' }); });
    return () => { active = false; controller.abort(); };
  }, [id, retry]);
  return { ...(state.id === id ? state : { id }), reload: () => setRetry(n => n + 1) };
}
export function ModelSelectModal({ componentType, onConfirm, onCancel, projectPassports }: ModelSelectModalProps) {
  const [source, setSource] = useState('shared');
  const [projectVersion, setProjectVersion] = useState<PassportVersion | null>(null);
  const [catalog, setCatalog] = useState<{ code: string; models: api.EquipmentModel[]; template: api.ComponentParam[] }>();
  const [selected, setSelected] = useState<number | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const [query, setQuery] = useState(''); const [manufacturer, setManufacturer] = useState('');
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const confirming = useRef(false);
  const [catalogError, setCatalogError] = useState(''); const [saveError, setSaveError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setCatalog(undefined); setSelected(null); setCompare(null); setQuery(''); setManufacturer(''); setLoading(true); setCatalogError(''); setSaveError('');
    Promise.all([api.getEquipmentModels(componentType.code, controller.signal), api.getComponentParams(componentType.code, controller.signal)])
      .then(([models, template]) => { if (active) setCatalog({ code: componentType.code, models, template }); })
      .catch(() => { if (active) setCatalogError('Не удалось загрузить каталог. Можно повторить запрос или задать параметры самостоятельно.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [componentType.code, retry]);
  const current = catalog?.code === componentType.code ? catalog : undefined;
  const models = current?.models ?? [];
  const model = models.find(item => item.id === selected);
  const other = models.find(item => item.id === compare && item.id !== selected);
  const primary = usePassport(model?.id ?? null); const secondary = usePassport(other?.id ?? null);
  const search = query.trim().toLocaleLowerCase();
  const visible = models.filter(item => (!manufacturer || item.manufacturer === manufacturer) &&
    [item.model_name, item.manufacturer, item.description].some(value => value.toLocaleLowerCase().includes(search)));
  const ready = source === 'project' ? Boolean(projectPassports && projectVersion?.document.componentTypeCode === componentType.code) : selected === null || Boolean(model && primary.params);
  const rows = primary.params ? passportRows(current?.template ?? [], [primary.params, ...(other && secondary.params ? [secondary.params] : [])]) : [];
  async function confirm() {
    if (!ready || (source === 'shared' && loading) || confirming.current) return;
    // React may batch two confirmations before it renders the disabled button.
    confirming.current = true;
    setBusy(true); setSaveError('');
    try { if (source === 'project' && projectVersion) await onConfirm(null, projectVersion.id); else await onConfirm(selected); }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Не удалось добавить оборудование. Повторите попытку.'); }
    finally { confirming.current = false; setBusy(false); }
  }
  return <Dialog title={`Добавить: ${componentType.name}`} onClose={onCancel} closeDisabled={busy} wide>
    <p className="dialog-intro">Выберите паспорт оборудования и проверьте его параметры перед добавлением на схему. Паспорт изделия не определяет математическую модель.</p>
    {projectPassports && <label className="passport-field">Источник паспорта<select value={source} disabled={busy} onChange={event => { setSource(event.target.value); setProjectVersion(null); setSaveError(''); }}><option value="shared">Общий справочник / свои параметры</option><option value="project">Паспорта текущего проекта</option></select></label>}
    {source === 'project' && projectPassports ? <ProjectPassportPicker read={projectPassports} typeCode={componentType.code} selected={projectVersion} onSelect={version => { setProjectVersion(version); setSaveError(''); }} disabled={busy} template={current?.template ?? []} /> : <>
    <label className={`passport-manual ${selected === null ? 'is-selected' : ''}`}>
      <input type="radio" name="equipment-model" checked={selected === null} disabled={busy} onChange={() => { setSelected(null); setCompare(null); }} />
      <span><strong>Задать параметры самостоятельно</strong><small>Физические параметры нужно заполнить перед расчётом.</small></span>
    </label>
    {loading && <p role="status">Загрузка каталога…</p>}
    {catalogError && <div role="alert" className="passport-notice"><p>{catalogError}</p><button className="tool-btn" disabled={busy} onClick={() => setRetry(n => n + 1)}>Повторить загрузку каталога</button></div>}
    {current && <div className="passport-layout">
      <section className="passport-browser" aria-label="Паспорта оборудования">
        <label className="passport-field">Поиск в каталоге<input type="search" value={query} disabled={busy} placeholder="Название, завод, описание" onChange={event => setQuery(event.target.value)} /></label>
        <label className="passport-field">Производитель<select value={manufacturer} disabled={busy} onChange={event => setManufacturer(event.target.value)}><option value="">Все производители</option>{[...new Set(models.map(item => item.manufacturer).filter(Boolean))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
        <p className="passport-count" role="status">Найдено: {visible.length} из {models.length}</p>
        <div className="passport-options">{visible.map(item => <label key={item.id} className={`passport-option ${selected === item.id ? 'is-selected' : ''}`}>
          <input type="radio" name="equipment-model" checked={selected === item.id} disabled={busy} onChange={() => { setSelected(item.id); if (compare === item.id) setCompare(null); setSaveError(''); }} />
          <span><strong>{item.model_name}</strong><small>{item.manufacturer || 'Производитель не указан'}</small><span>{item.description}</span></span>
        </label>)}{!visible.length && <p className="passport-empty">{models.length ? 'Нет совпадений. Измените поиск или производителя.' : 'Для этого типа пока нет паспортов.'}</p>}</div>
      </section>
      <section className="passport-preview" aria-label="Просмотр паспорта">
        {!model ? <div className="passport-empty"><h3>Параметры под вашим контролем</h3><p>Выберите паспорт слева, чтобы увидеть сохранённые значения и сравнить варианты.</p><p>Шаблонные значения не подставляются в паспорт автоматически.</p></div> : <>
          <div className="passport-heading"><span>ВЫБРАННЫЙ ПАСПОРТ</span><h3>{model.model_name}</h3><p>{model.manufacturer || 'Производитель не указан'}</p></div>
          <p>{model.description}</p>
          <p className="passport-provenance">Источник и версия паспортных данных в каталоге не указаны. Наличие паспорта не подтверждает поддержку расчётной модели.</p>
          <label className="passport-field">Сравнить с<select value={other?.id ?? ''} disabled={busy} onChange={event => setCompare(event.target.value ? Number(event.target.value) : null)}><option value="">Без сравнения</option>{models.filter(item => item.id !== selected).map(item => <option key={item.id} value={item.id}>{item.model_name}{item.manufacturer ? ` · ${item.manufacturer}` : ''}</option>)}</select></label>
          {!primary.params && !primary.error && <p role="status">Загрузка параметров…</p>}
          {primary.error && <div role="alert"><p>{primary.error}</p><button className="tool-btn" disabled={busy} onClick={primary.reload}>Повторить загрузку параметров</button></div>}
          {other && !secondary.params && !secondary.error && <p role="status">Загрузка сравнения…</p>}
          {other && secondary.error && <div role="alert"><p>{secondary.error}</p><button className="tool-btn" disabled={busy} onClick={secondary.reload}>Повторить сравнение</button></div>}
          {primary.params && <>
            <p className="passport-count">Параметров в паспорте: {Object.keys(primary.params).length}</p>
            {other && secondary.params && <p role="status">Различий в сохранённых значениях: {rows.filter(row => row.different).length}. Сравнение строк без пересчёта единиц.</p>}
            <div className="passport-table-wrap"><table className="passport-table"><caption>Сохранённые паспортные параметры · единицы из шаблона типа</caption><thead><tr><th scope="col">Параметр / единица</th><th scope="col">{model.model_name}</th>{other && secondary.params && <th scope="col">{other.model_name}</th>}</tr></thead><tbody>{rows.map(row => <tr key={row.key} className={row.different ? 'passport-different' : ''}><th scope="row">{row.name}<small>{row.key} · {row.unit ?? 'единица не указана'}{row.different ? ' · Различается' : ''}</small></th>{row.values.map((value, index) => <td key={index}>{value === undefined ? 'Не задано' : value === '' ? 'Пустое значение' : value}</td>)}</tr>)}</tbody></table></div>
          </>}
        </>}
      </section>
    </div>}
    </>}
    {saveError && <p role="alert">{saveError}</p>}
    <div className="dialog-actions"><button className="tool-btn" onClick={onCancel} disabled={busy}>Отмена</button><button className="tool-btn primary" onClick={confirm} disabled={(source === 'shared' && loading) || busy || !ready}>{busy ? 'Добавление…' : 'Добавить на схему'}</button></div>
  </Dialog>;
}
