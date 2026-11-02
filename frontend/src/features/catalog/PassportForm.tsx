import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getComponentTypes, getComponentParams, type ComponentParam } from '../../api/ees-api';
import { SessionError } from '../../api/projects-api';
import { parsePassportDocument, saveProjectPassport, type PassportAttempt, type PassportDocument, type PassportVersion } from '../../api/project-passports-api';
import { parameterBaseDraft } from '../../domain/parameter-base';
import { ParameterBaseFields } from '../../components/ui/ParameterBaseFields';

export function PassportForm({ projectId, original, mode, onSaved, onCancel, onUnavailable }: {
  projectId: string; original: PassportVersion | null; mode: 'new' | 'clone' | 'revise';
  onSaved: (version: PassportVersion) => void; onCancel: () => void; onUnavailable: () => void;
}) {
  const [doc, setDoc] = useState<PassportDocument>(() => original ? { ...original.document,
    name: mode === 'clone' ? `${original.document.name} (копия)`.slice(0, 200) : original.document.name,
    parameters: Object.fromEntries(Object.entries(original.document.parameters).map(([key, p]) => [key, { ...p, ...(p.base ? { base: { ...p.base } } : {}) }])) } : { formatVersion: 1, componentTypeCode: '', name: '', manufacturer: '', source: '', license: '', parameters: {} });
  const [unitChoices, setUnitChoices] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(original?.document.parameters ?? {}).map(([key,p]) => [key,p.unit])));
  const [sourceBases, setSourceBases] = useState<Record<string, { power: string; voltage: string }>>(() => Object.fromEntries(Object.entries(original?.document.parameters ?? {}).map(([key,p]) => [key,{ power:p.base?.s_base_mva.toString() ?? '', voltage:p.base?.v_base_kv.toString() ?? '' }])));
  const sourceDraft = (key: string) => Object.prototype.hasOwnProperty.call(sourceBases,key) ? sourceBases[key] : { power:'', voltage:'' };
  const unitFor = (p: ComponentParam) => Object.prototype.hasOwnProperty.call(unitChoices,p.key) ? unitChoices[p.key] : p.unit;
  const [types, setTypes] = useState<{ code: string; name: string }[]>([]), [template, setTemplate] = useState<ComponentParam[] | null>(null);
  const [metadataError, setMetadataError] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false), [pending, setPending] = useState(false);
  const attempt = useRef<PassportAttempt | null>(null), running = useRef(false), command = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => () => command.current?.abort(), []);
  useEffect(() => {
    let active = true; const controller = new AbortController(); setTemplate(null); setMetadataError('');
    void Promise.all([getComponentTypes(), doc.componentTypeCode ? getComponentParams(doc.componentTypeCode, controller.signal) : Promise.resolve(null)])
      .then(([types, params]) => {
        if (!Array.isArray(types) || !types.every(t => typeof t.code === 'string' && typeof t.name === 'string')) throw new Error();
        if (active) { setTypes(types); setTemplate(params); }
      }).catch(() => { if (active) setMetadataError('Не удалось загрузить типы и единицы параметров.'); });
    return () => { active = false; controller.abort(); };
  }, [doc.componentTypeCode, retry]);
  const incompatible = template && Object.entries(doc.parameters).some(([key, p]) => !template.some(t => t.key === key && (t.unit === p.unit || t.type === 'number' && p.unit === 'p.u.')));
  const field = (key: 'name' | 'manufacturer' | 'source' | 'license', value: string) => setDoc(d => ({ ...d, [key]: value }));
  const parameter = (p: ComponentParam, value: string) => setDoc(d => {
    const parameters = { ...d.parameters }; if (value === '') delete parameters[p.key]; else parameters[p.key] = { ...parameters[p.key], value, unit: unitFor(p) };
    return { ...d, parameters };
  });
  const chooseUnit = (p: ComponentParam, unit: string) => {
    setUnitChoices(previous => ({ ...previous, [p.key]:unit }));
    if (unit !== 'p.u.') setSourceBases(previous => ({ ...previous, [p.key]:{ power:'', voltage:'' } }));
    setDoc(previous => ({ ...previous, formatVersion:unit === 'p.u.' ? 2 : previous.formatVersion,
      parameters: Object.fromEntries(Object.entries(previous.parameters).map(([key,value]) => [key, key === p.key ? { value:value.value, unit } : value])) }));
    setError('');
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (running.current || (!attempt.current && (!template || incompatible || !Object.keys(doc.parameters).length))) return;
    let current = attempt.current;
    if (!current) {
      try {
        const document = parsePassportDocument({ ...doc, parameters:Object.fromEntries(Object.entries(doc.parameters).map(([key,p]) => {
          const draft = sourceDraft(key);
          return [key, p.unit === 'p.u.' ? { ...p, base:parameterBaseDraft(draft.power,draft.voltage) } : { value:p.value, unit:p.unit }];
        })) });
        if (template?.some(p => document.parameters[p.key] && p.type === 'number' &&
            (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(document.parameters[p.key].value) || !Number.isFinite(Number(document.parameters[p.key].value))))) throw new Error();
        current = { commandId: crypto.randomUUID(), predecessorId: mode === 'revise' && original ? original.id : null, document };
      } catch { setError('Заполните название, источник, условия использования и корректные значения параметров. Для p.u. явно задайте положительные конечные Sб и Uб.'); return; }
    }
    attempt.current = current; running.current = true; setSaving(true); setPending(true); setError('');
    const controller = new AbortController(); command.current = controller;
    try { const v = await saveProjectPassport(projectId, current, controller.signal); if (!controller.signal.aborted) onSaved(v); }
    catch (e) {
      if (!controller.signal.aborted) {
        if (e instanceof SessionError && [400, 413, 415].includes(e.status)) { attempt.current = null; setPending(false); }
        if (e instanceof SessionError && [401, 404].includes(e.status)) { onUnavailable(); return; }
        setError(e instanceof Error ? e.message : 'Сохранение паспорта не подтверждено.');
      }
    } finally { if (!controller.signal.aborted) { running.current = false; setSaving(false); } }
  };
  return <form className="passport-editor" aria-label="Паспорт проекта" onSubmit={event => void submit(event)}>
    <div className="catalog-heading"><div><span className="eyebrow">Черновик</span><h3 ref={heading} tabIndex={-1}>{mode === 'revise' ? `Новая версия паспорта №${original?.id}` : mode === 'clone' ? 'Копия паспорта' : 'Новый паспорт'}</h3></div>
      <button type="button" className="tool-btn" disabled={saving} onClick={onCancel}>Закрыть форму</button></div>
    <p className="projects-note">Заполните данные изделия и укажите их источник. Пустые параметры не сохраняются; шаблонные значения не подставляются. Проверка полноты для расчёта выполняется отдельно.</p>
    <fieldset disabled={pending || saving}>
      <div className="passport-fields">
        <label>Тип оборудования<select required value={doc.componentTypeCode} disabled={mode !== 'new'} onChange={e => { setUnitChoices({}); setSourceBases({}); setDoc(d => ({ ...d, formatVersion:1, componentTypeCode: e.target.value, parameters: {} })); }}>
          <option value="">Выберите тип</option>{types.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}</select></label>
        <label>Название паспорта<input required maxLength={200} value={doc.name} onChange={e => field('name', e.target.value)} /></label>
        <label>Производитель<input maxLength={200} value={doc.manufacturer} onChange={e => field('manufacturer', e.target.value)} /></label>
        <label>Условия использования данных<input required maxLength={200} value={doc.license} onChange={e => field('license', e.target.value)} /></label>
      </div>
      <label>Источник данных<textarea required maxLength={4000} rows={3} value={doc.source} onChange={e => field('source', e.target.value)} /></label>
      <h4>Параметры и единицы</h4>
      <p className="projects-note">Единица и исходный базис задают представление коэффициента. При их смене число не пересчитывается.</p>
      {template && <div className="passport-fields">{template.map(p => <div key={p.key} className="passport-parameter-editor"><label>{p.name} <span className="catalog-unit">{unitFor(p) || 'безразмерно'}</span>
        {p.type === 'boolean' ? <select value={doc.parameters[p.key]?.value ?? ''} onChange={e => parameter(p, e.target.value)}><option value="">Не задано</option><option value="true">Да</option><option value="false">Нет</option></select>
          : <input inputMode={p.type === 'number' ? 'decimal' : 'text'} maxLength={1000} value={doc.parameters[p.key]?.value ?? ''} onChange={e => parameter(p, e.target.value)} />}</label>
        {p.type === 'number' && <label>Представление · {p.name}<select value={unitFor(p)} onChange={event => chooseUnit(p,event.target.value)}>
          {unitFor(p) !== p.unit && unitFor(p) !== 'p.u.' && <option value={unitFor(p)} disabled>{unitFor(p)} · исходная единица</option>}
          <option value={p.unit}>{p.unit || 'Безразмерная величина'} · единица шаблона</option><option value="p.u.">p.u. · явный исходный базис</option>
        </select></label>}
        {p.type === 'number' && unitFor(p) === 'p.u.' && <ParameterBaseFields power={sourceDraft(p.key).power} voltage={sourceDraft(p.key).voltage} onChange={(field,value) => setSourceBases(previous => ({ ...previous, [p.key]:{ ...(Object.prototype.hasOwnProperty.call(previous,p.key) ? previous[p.key] : { power:'',voltage:'' }), [field]:value } }))} />}
      </div>)}</div>}
    </fieldset>
    {metadataError && <p role="alert">{metadataError} <button type="button" className="tool-btn" onClick={() => setRetry(v => v + 1)}>Повторить загрузку полей</button></p>}
    {doc.componentTypeCode && !template && !metadataError && <p role="status">Загрузка полей паспорта…</p>}
    {incompatible && <p role="alert">Ключи или единицы исходного паспорта отличаются от текущего шаблона. Сохранение заблокировано, исходные данные не изменены.</p>}
    {error && <p role="alert" className="projects-error">{error}</p>}
    {pending && !saving && <p className="projects-note">Подтверждение не получено. Повтор отправит тот же паспорт с тем же номером команды. Перед закрытием формы проверьте список; после её закрытия команда не восстанавливается.</p>}
    <button className="tool-btn primary" disabled={saving || (!pending && (!template || !!incompatible || !Object.keys(doc.parameters).length))}>
      {saving ? 'Сохраняем паспорт…' : pending ? 'Повторить исходное сохранение' : 'Сохранить версию паспорта'}</button>
  </form>;
}
