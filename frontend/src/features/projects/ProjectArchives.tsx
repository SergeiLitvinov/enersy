import { useEffect, useRef, useState } from 'react';
import { listCalculationArchives, readCalculationArchive, type CalculationArchive, type OpenCalculationArchive } from '../../api/calculation-archives-api';
import { SessionError, type Project } from '../../api/projects-api';
import { ArchiveResultView } from './ArchiveResultView';
import './ProjectArchives.css';
type Props = { project: Project; onBack: () => void; onUnavailable?: () => void };
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
export function ProjectArchives(props: Props) { return <ArchiveList key={props.project.id} {...props} />; }
function ArchiveList({ project, onBack, onUnavailable }: Props) {
  const [items, setItems] = useState<CalculationArchive[]>([]), [cursor, setCursor] = useState(''), [next, setNext] = useState('');
  const [reload, refresh] = useState(0), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [opening, setOpening] = useState(''), [opened, setOpened] = useState<OpenCalculationArchive | null>(null);
  const command = useRef<AbortController | null>(null);
  useEffect(() => () => command.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); command.current?.abort(); setOpening(''); setOpened(null); setItems([]); setNext(''); setBusy(true); setError('');
    void (async () => {
      try { const p = await listCalculationArchives(project.id, controller.signal, cursor); if (!controller.signal.aborted) { setItems(p.items); setNext(p.nextBeforeId); } }
      catch (e) { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Архив недоступен'); if (e instanceof SessionError && [401, 404].includes(e.status)) onUnavailable?.(); } }
      finally { if (!controller.signal.aborted) setBusy(false); }
    })(); return () => controller.abort();
  }, [project.id, cursor, reload, onUnavailable]);
  const close = () => { command.current?.abort(); setOpened(null); setOpening(''); };
  const open = async (id: string) => {
    close(); const c = new AbortController(); command.current = c; setOpening(id); setError('');
    try { const v = await readCalculationArchive(project.id, id, c.signal); if (!c.signal.aborted) setOpened(v); }
    catch (e) { if (!c.signal.aborted) { setError(e instanceof Error ? e.message : 'Не удалось открыть расчёт'); if (e instanceof SessionError && [401, 404].includes(e.status)) { setItems([]); setNext(''); onUnavailable?.(); } } }
    finally { if (!c.signal.aborted) setOpening(''); }
  };
  return <section aria-label={`Архив расчётов проекта ${project.name}`} className="project-archives">
    <div className="projects-session"><div><span className="eyebrow">{project.name}</span><h2>Архив расчётов</h2></div><div><button className="tool-btn" onClick={onBack}>К схемам проекта</button><button className="tool-btn" disabled={busy} onClick={() => refresh(v => v + 1)}>Обновить архив</button></div></div>
    <p className="projects-note">Результаты и входные данные на момент расчёта. Изменение или удаление схемы не меняет архив. Участники проекта видят общий архив.</p>
    {error && <p role="alert" className="projects-error">{error}</p>}
    {busy ? <p role="status">Загружаем архив…</p> : <>
      {!items.length && !error && <p className="projects-empty">На этой странице нет расчётов. Успешные расчёты приватного редактора сохраняются здесь автоматически.</p>}
      <ul className="archive-cards">{items.map(i => <li key={i.id}><div><span className="eyebrow">Расчёт №{i.id} · {date.format(new Date(i.createdAt))}</span><h3>{i.schemeName}</h3><p>Схема №{i.schemeId} · топология {i.topologyRevision} · автор №{i.authorAccountId}</p><p>{i.modelGroup} / {i.method}</p></div><button className="tool-btn primary" disabled={!!opening} onClick={() => void open(i.id)}>Открыть расчёт №{i.id}</button></li>)}</ul>
      <div className="projects-pages"><button className="tool-btn" disabled={!cursor} onClick={() => setCursor('')}>Новые расчёты</button>{next && <button className="tool-btn" onClick={() => setCursor(next)}>Более ранние расчёты</button>}</div>
    </>}
    {opening && <div role="status">Открываем расчёт №{opening}… <button className="tool-btn" onClick={close}>Отменить открытие</button></div>}
    {opened && <ArchiveResultView archive={opened} onClose={close}/>}
  </section>;
}
