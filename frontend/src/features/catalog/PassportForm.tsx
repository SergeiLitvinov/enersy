import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getComponentTypes, getComponentParams, type ComponentParam } from '../../api/ees-api';
import { SessionError } from '../../api/projects-api';
import { parsePassportDocument, saveProjectPassport, type PassportAttempt, type PassportDocument, type PassportVersion } from '../../api/project-passports-api';

export function PassportForm({ projectId, original, mode, onSaved, onCancel, onUnavailable }: {
  projectId: string; original: PassportVersion | null; mode: 'new' | 'clone' | 'revise';
  onSaved: (version: PassportVersion) => void; onCancel: () => void; onUnavailable: () => void;
}) {
  const [doc, setDoc] = useState<PassportDocument>(() => original ? { ...original.document,
    name: mode === 'clone' ? `${original.document.name} (копия)`.slice(0, 200) : original.document.name,
    parameters: { ...original.document.parameters } } : { formatVersion: 1, componentTypeCode: '', name: '', manufacturer: '', source: '', license: '', parameters: {} });
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
  const incompatible = template && Object.entries(doc.parameters).some(([key, p]) => !template.some(t => t.key === key && t.unit === p.unit));
  const field = (key: 'name' | 'manufacturer' | 'source' | 'license', value: string) => setDoc(d => ({ ...d, [key]: value }));
  const parameter = (p: ComponentParam, value: string) => setDoc(d => {
    const parameters = { ...d.parameters }; if (value === '') delete parameters[p.key]; else parameters[p.key] = { value, unit: p.unit };
    return { ...d, parameters };
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (running.current || (!attempt.current && (!template || incompatible || !Object.keys(doc.parameters).length))) return;
    let current = attempt.current;
    if (!current) {
      try {
        const document = parsePassportDocument(doc);
        if (template?.some(p => document.parameters[p.key] && p.type === 'number' &&
            (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(document.parameters[p.key].value) || !Number.isFinite(Number(document.parameters[p.key].value))))) throw new Error();
        current = { commandId: crypto.randomUUID(), predecessorId: mode === 'revise' && original ? original.id : null, document };
      } catch { setError('Заполните название, источник, условия использования и корректные значения параметров.'); return; }
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
        <label>Тип оборудования<select required value={doc.componentTypeCode} disabled={mode !== 'new'} onChange={e => setDoc(d => ({ ...d, componentTypeCode: e.target.value, parameters: {} }))}>
          <option value="">Выберите тип</option>{types.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}</select></label>
        <label>Название паспорта<input required maxLength={200} value={doc.name} onChange={e => field('name', e.target.value)} /></label>
        <label>Производитель<input maxLength={200} value={doc.manufacturer} onChange={e => field('manufacturer', e.target.value)} /></label>
        <label>Условия использования данных<input required maxLength={200} value={doc.license} onChange={e => field('license', e.target.value)} /></label>
      </div>
      <label>Источник данных<textarea required maxLength={4000} rows={3} value={doc.source} onChange={e => field('source', e.target.value)} /></label>
      <h4>Параметры и единицы</h4>
      {template && <div className="passport-fields">{template.map(p => <label key={p.key}>{p.name} <span className="catalog-unit">{p.unit || 'безразмерно'}</span>
        {p.type === 'boolean' ? <select value={doc.parameters[p.key]?.value ?? ''} onChange={e => parameter(p, e.target.value)}><option value="">Не задано</option><option value="true">Да</option><option value="false">Нет</option></select>
          : <input inputMode={p.type === 'number' ? 'decimal' : 'text'} maxLength={1000} value={doc.parameters[p.key]?.value ?? ''} onChange={e => parameter(p, e.target.value)} />}</label>)}</div>}
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
