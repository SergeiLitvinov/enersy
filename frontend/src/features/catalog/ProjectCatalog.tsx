import { useEffect, useRef, useState } from 'react';
import { listProjectPassports, readProjectPassport, type PassportVersion } from '../../api/project-passports-api';
import { SessionError, type Project } from '../../api/projects-api';
import { PassportForm } from './PassportForm';
import './ProjectCatalog.css';

type Props = { project: Project; onBack: () => void; onUnavailable?: () => void };
export function ProjectCatalog(props: Props) { return <Catalog key={`${props.project.id}:${props.project.role}`} {...props} />; }
function Catalog({ project, onBack, onUnavailable }: Props) {
  const [items, setItems] = useState<PassportVersion[]>([]), [cursor, setCursor] = useState(''), [next, setNext] = useState('');
  const [reload, refresh] = useState(0), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [selected, select] = useState<PassportVersion | null>(null), [opening, setOpening] = useState('');
  const [form, setForm] = useState<{ original: PassportVersion | null; mode: 'new' | 'clone' | 'revise' } | null>(null);
  const [savedId, setSavedId] = useState('');
  const detailHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (selected) detailHeading.current?.focus(); }, [selected]);
  const command = useRef<AbortController | null>(null);
  useEffect(() => () => command.current?.abort(), []);
  const unavailable = () => { setItems([]); setNext(''); select(null); setForm(null); setSavedId(''); setError('Каталог проекта недоступен.'); onUnavailable?.(); };
  useEffect(() => {
    const controller = new AbortController(); command.current?.abort(); select(null); setOpening(''); setItems([]); setNext(''); setBusy(true); setError('');
    void listProjectPassports(project.id, controller.signal, cursor).then(p => { if (!controller.signal.aborted) { setItems(p.items); setNext(p.nextAfterId); } })
      .catch(e => { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Каталог недоступен'); if (e instanceof SessionError && [401, 404].includes(e.status)) { setForm(null); onUnavailable?.(); } } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [project.id, cursor, reload, onUnavailable]);
  const open = async (id: string) => {
    command.current?.abort(); const controller = new AbortController(); command.current = controller; select(null); setOpening(id); setError('');
    try { const v = await readProjectPassport(project.id, id, controller.signal); if (!controller.signal.aborted) select(v); }
    catch (e) { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Паспорт недоступен'); if (e instanceof SessionError && [401, 404].includes(e.status)) unavailable(); } }
    finally { if (!controller.signal.aborted) setOpening(''); }
  };
  return <section className="project-catalog" aria-label={`Каталог проекта ${project.name}`}>
    <div className="projects-session"><div><span className="eyebrow">{project.name}</span><h2>Паспорта проекта</h2></div><div>
      <button className="tool-btn" onClick={onBack}>К схемам проекта</button><button className="tool-btn" disabled={busy} onClick={() => refresh(v => v + 1)}>Обновить паспорта</button>
      {project.role !== 'viewer' && !form && <button className="tool-btn primary" onClick={() => setForm({ original: null, mode: 'new' })}>Новый паспорт</button>}</div></div>
    <p className="projects-note">Версии доступны участникам этого проекта. Черновик хранит данные изделия и их источник; расчётная применимость и публикация ещё не подтверждены. В редакторе схемы выберите «Паспорта текущего проекта» при добавлении оборудования. Экземпляр сохранит выбранную версию.</p>
    {error && <p role="alert" className="projects-error">{error}</p>}
    {savedId && <p role="status" className="catalog-saved">Сохранён паспорт №{savedId}. <button className="tool-btn" disabled={!!opening} onClick={() => void open(savedId)}>Посмотреть сохранённую версию</button></p>}
    {form && <PassportForm key={`${form.mode}:${form.original?.id ?? 'new'}`} projectId={project.id} {...form} onCancel={() => setForm(null)} onUnavailable={unavailable}
      onSaved={v => { setForm(null); setCursor(''); refresh(n => n + 1); setError(''); setSavedId(v.id); select(null); }} />}
    {busy ? <p role="status">Загружаем паспорта…</p> : <>
      <ul className="catalog-versions">{items.map(v => <li key={v.id}><div><span className="eyebrow">Черновик · версия {v.revision} · №{v.id}</span><h3>{v.document.name}</h3><p>{v.document.manufacturer || 'Производитель не указан'} · {v.document.componentTypeCode}</p></div>
        <button className="tool-btn" disabled={!!opening} onClick={() => void open(v.id)}>Открыть паспорт №{v.id}</button></li>)}</ul>
      {!items.length && !error && <p className="projects-empty">На этой странице нет паспортов.</p>}
      <div className="projects-pages"><button className="tool-btn" disabled={!cursor} onClick={() => setCursor('')}>Начало каталога</button>{next && <button className="tool-btn" onClick={() => setCursor(next)}>Следующие паспорта</button>}</div>
    </>}
    {opening && <p role="status">Открываем паспорт №{opening}…</p>}
    {selected && <article className="catalog-detail"><span className="eyebrow">Сохранённая версия {selected.revision} · №{selected.id}</span><h3 ref={detailHeading} tabIndex={-1}>{selected.document.name}</h3>
      <dl><dt>Производитель</dt><dd>{selected.document.manufacturer || 'Не указан'}</dd><dt>Источник</dt><dd>{selected.document.source}</dd><dt>Условия использования</dt><dd>{selected.document.license}</dd></dl>
      <table><caption>Сохранённые параметры</caption><thead><tr><th>Ключ</th><th>Значение</th><th>Единица</th></tr></thead><tbody>{Object.entries(selected.document.parameters).map(([key, p]) => <tr key={key}><th scope="row">{key}</th><td>{p.value}</td><td>{p.unit || 'безразмерно'}</td></tr>)}</tbody></table>
      <details><summary>Происхождение версии</summary><p>Автор №{selected.authorAccountId} · {new Date(selected.createdAt).toLocaleString('ru-RU')}. Предшественник: {selected.predecessorId ?? 'нет'}.</p><p className="catalog-digest">SHA-256: {selected.sha256}</p></details>
      {project.role !== 'viewer' && !form && <div className="catalog-actions"><button className="tool-btn primary" onClick={() => setForm({ original: selected, mode: 'revise' })}>Создать следующую версию</button><button className="tool-btn" onClick={() => setForm({ original: selected, mode: 'clone' })}>Клонировать как новый паспорт</button></div>}
    </article>}
  </section>;
}
