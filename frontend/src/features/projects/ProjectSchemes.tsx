import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createProjectScheme, listProjectSchemes, readProjectScheme, SessionError, type Project, type Identity, type ProjectSchemePage } from '../../api/projects-api';
import { parseProjectGraph, type ProjectGraph } from './project-graph';
import { SchemePreview } from './SchemePreview';
import { ProjectEditor } from './ProjectEditor';
import { ProjectArchives } from './ProjectArchives';
import { ProjectStudies } from './ProjectStudies';
import { ProjectCatalog } from '../catalog/ProjectCatalog';
export function ProjectSchemes({ project, identity, onBack, onUnavailable }: { project: Project; identity: Identity; onBack: () => void; onUnavailable?: () => void }) {
  const [archives, showArchives] = useState(false);
  const [studies, showStudies] = useState<'list' | 'create' | null>(null);
  const [catalog, showCatalog] = useState(false);
  const [page, setPage] = useState<ProjectSchemePage>({ items: [], nextAfterId: '' });
  const [cursor, setCursor] = useState('');
  const [selected, select] = useState('');
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [reload, refresh] = useState(0);
  const command = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => () => command.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setPage({ items: [], nextAfterId: '' }); setGraph(null); setError(''); setBusy(true);
    const load = async () => {
      try {
        const next = await listProjectSchemes(project.id, controller.signal, cursor);
        if (controller.signal.aborted) return;
        setPage(next);
        if (selected) {
          const data = await readProjectScheme(project.id, selected, controller.signal);
          if (!controller.signal.aborted) setGraph(parseProjectGraph(data, project.id, selected));
        }
      } catch (error) { if (!controller.signal.aborted) { setPage({ items: [], nextAfterId: '' }); setGraph(null); setError(error instanceof Error ? error.message : 'Не удалось прочитать проект');
        if (error instanceof SessionError && (error.status === 401 || error.status === 404)) onUnavailable?.(); } }
      finally { if (!controller.signal.aborted) setBusy(false); }
    };
    void load();
    return () => controller.abort();
  }, [project.id, cursor, selected, reload, onUnavailable]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const controller = new AbortController(); command.current = controller;
    setSaving(true); setError('');
    try {
      const id = await createProjectScheme(project.id, name.trim(), description, controller.signal);
      if (controller.signal.aborted) return;
      setName(''); setDescription(''); setCursor(''); select(id); refresh(value => value+1);
    } catch (error) { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Создание схемы не подтверждено');
      if (error instanceof SessionError && (error.status === 401 || error.status === 404)) onUnavailable?.(); } }
    finally { if (!controller.signal.aborted) setSaving(false); }
  };
  if (archives) return <ProjectArchives project={project} onBack={() => showArchives(false)} onUnavailable={onUnavailable} />;
  if (studies) return <ProjectStudies identity={identity} project={project} source={graph ?? undefined} autoCreate={studies === 'create'} onBack={() => showStudies(null)} onUnavailable={onUnavailable} />;
  if (catalog) return <ProjectCatalog project={project} onBack={() => showCatalog(false)} onUnavailable={onUnavailable} />;
  if (editing && graph && project.role !== 'viewer') return <ProjectEditor key={`${project.id}:${graph.id}`} project={project} graph={graph} onUnavailable={onUnavailable} onClose={() => { setEditing(false); refresh(value => value + 1); }} />;
  return <div className="project-schemes"><div className="projects-session"><button className="tool-btn" onClick={onBack}>Все проекты</button><h2>{project.name}</h2><button className="tool-btn" onClick={() => showStudies('list')}>Исследования</button><button className="tool-btn" onClick={() => showArchives(true)}>Архив расчётов</button><button className="tool-btn" onClick={() => showCatalog(true)}>Паспорта проекта</button><button className="tool-btn" disabled={busy || saving} onClick={() => refresh(value => value+1)}>Обновить схемы</button></div>
    {error && <p role="alert" className="projects-error">{error}</p>}
    {project.role !== 'viewer' && <form className="project-create" onSubmit={event => void create(event)}><label htmlFor="private-scheme-name">Новая схема</label><input id="private-scheme-name" required maxLength={200} value={name} onChange={event => setName(event.target.value)} />
      <label htmlFor="private-scheme-description">Описание</label><textarea id="private-scheme-description" maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} />
      <button className="tool-btn primary" disabled={busy || saving || !name.trim()}>Создать схему</button></form>}
    {busy ? <p role="status">Загружаем схемы проекта…</p> : <>
      <ul className="project-cards">{page.items.map(item => <li key={item.id}><button className="tool-btn" aria-pressed={item.id === selected} onClick={() => select(item.id)}>{item.name}</button><p>{item.description}</p></li>)}</ul>
      {!page.items.length && <p className="projects-empty">В проекте пока нет схем на этой странице.</p>}
      <div className="projects-pages"><button className="tool-btn" onClick={() => { setCursor(''); select(''); }}>Первая страница схем</button>{page.nextAfterId && <button className="tool-btn" onClick={() => { setCursor(page.nextAfterId); select(''); }}>Следующая страница схем</button>}</div>
      {graph && <div className="project-graph"><div className="projects-session"><h2>{graph.name}</h2>{project.role !== 'viewer' && <button className="tool-btn primary" onClick={() => setEditing(true)}>Редактировать схему</button>}{project.role !== 'viewer' && <button className="tool-btn" onClick={() => showStudies('create')}>Сохранить исследование</button>}</div><p>{graph.components.length} объектов · {graph.connections.length} связей · топология {graph.topologyRevision}</p><SchemePreview key={`${project.id}:${graph.id}:${reload}`} graph={graph} /></div>}
    </>}
    <p className="projects-note">Просмотр использует сохранённую геометрию и УГО. Владелец и редакторы могут открыть схему для изменения оборудования, связей и расчёта; читателям доступен просмотр.</p>
  </div>;
}
