import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createProject, listProjects, login, logout, readSession, type Identity, type Project, type ProjectPage } from '../../api/projects-api';
import { ProjectSchemes } from './ProjectSchemes';
import { Icon } from '../../components/ui/Icon';
import './projects.css';

type View = { identity: Identity | null; page: ProjectPage; busy: boolean; error: string };
const emptyPage: ProjectPage = { items: [], nextAfterId: '' };
const roles = { owner: 'Владелец', admin: 'Администратор', editor: 'Редактор', viewer: 'Читатель' };

export function ProjectsWorkspace() {
  const [view, setView] = useState<View>({ identity: null, page: emptyPage, busy: true, error: '' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [selectedProject, selectProject] = useState<Project | null>(null);
  const privateView = useRef(view);
  const privateProject = useRef(selectedProject);
  privateView.current = view; privateProject.current = selectedProject;
  const current = useRef<{ version: number; controller?: AbortController; busy: boolean }>({ version: 0, busy: false });
  // Focus masks the mounted private context while validating its identity/role.
  // Explicit navigation/auth operations discard the old context immediately.
  const perform = useCallback(async (task: (signal: AbortSignal) => Promise<{ identity: Identity | null; page: ProjectPage }>, preserve = false) => {
    current.current.controller?.abort();
    const controller = new AbortController();
    const version = ++current.current.version;
    current.current.controller = controller;
    current.current.busy = true;
    const previous = privateView.current;
    const project = privateProject.current;
    if (!preserve) selectProject(null);
    setView(preserve ? { ...previous, busy: true, error: '' } : { identity: null, page: emptyPage, busy: true, error: '' });
    try {
      const result = await task(controller.signal);
      if (current.current.version === version) {
        if (preserve && (result.identity?.accountId !== previous.identity?.accountId || result.identity?.sessionId !== previous.identity?.sessionId ||
            (project && result.page.items.find(item => item.id === project.id)?.role !== project.role))) selectProject(null);
        setView({ ...result, busy: false, error: '' });
      }
    } catch (error) {
      if (current.current.version === version) { selectProject(null); setView({ identity: null, page: emptyPage, busy: false,
        error: error instanceof Error ? error.message : 'Не удалось загрузить проекты' }); }
    } finally { if (current.current.version === version) current.current.busy = false; }
  }, []);
  const refresh = useCallback((preserve = false) => perform(async signal => {
    const identity = await readSession(signal);
    signal.throwIfAborted();
    return { identity, page: identity ? await listProjects(signal) : emptyPage };
  }, preserve), [perform]);
  useEffect(() => {
    void refresh();
    const focus = () => { if (!current.current.busy) void refresh(true); };
    window.addEventListener('focus', focus);
    return () => { current.current.version++; current.current.controller?.abort(); window.removeEventListener('focus', focus); };
  }, [refresh]);
  const signIn = (event: FormEvent) => {
    event.preventDefault();
    const secret = password;
    setPassword('');
    void perform(async signal => {
      const identity = await login(username, secret, signal);
      signal.throwIfAborted();
      return { identity, page: await listProjects(signal) };
    });
  };
  const signOut = (all: boolean) => {
    setPassword(''); setName(''); setUsername('');
    void perform(async signal => { await logout(all, signal); return { identity: null, page: emptyPage }; });
  };
  const addProject = (event: FormEvent) => {
    event.preventDefault();
    const projectName = name.trim();
    setName('');
    void perform(async signal => {
      await createProject(projectName, signal);
      const identity = await readSession(signal);
      signal.throwIfAborted();
      return { identity, page: identity ? await listProjects(signal) : emptyPage };
    });
  };
  const nextPage = () => {
    const after = view.page.nextAfterId;
    void perform(async signal => {
      const identity = await readSession(signal);
      signal.throwIfAborted();
      // A cookie may have changed in another tab. Never carry a previous user's cursor.
      return { identity, page: identity ? await listProjects(signal, identity.accountId === view.identity?.accountId ? after : '') : emptyPage };
    });
  };
  return <section className="projects-workspace" aria-labelledby="projects-title">
    <div className="projects-intro"><span className="eyebrow">Личное пространство</span><h1 id="projects-title">Мои проекты</h1>
      <p>Сети, исследования и расчёты вашей команды — в одном пространстве.</p></div>
    {view.error && <div className="projects-error" role="alert">{view.error}<button className="tool-btn" onClick={() => void refresh()}>Проверить подключение</button></div>}
    {view.busy && <p role="status" className="projects-loading">Проверяем сессию и права доступа…</p>}
    {view.identity ? <div hidden={view.busy}>
      <div className="projects-session"><span><Icon name="check" /> Сессия активна</span><div>
        <button className="tool-btn" onClick={() => void refresh()}>Обновить</button>
        <button className="tool-btn" onClick={() => signOut(false)}>Выйти</button>
        <button className="tool-btn" onClick={() => signOut(true)}>Выйти из всех сессий</button></div></div>
      {selectedProject ? <ProjectSchemes key={`${view.identity.accountId}:${view.identity.sessionId}:${selectedProject.id}`} project={selectedProject} onBack={() => selectProject(null)} onUnavailable={refresh} /> : <><form className="project-create" onSubmit={addProject}><label htmlFor="project-name">Новый проект</label><div>
        <input id="project-name" value={name} onChange={event => setName(event.target.value)} maxLength={200} required placeholder="Например, подстанция Северная" />
        <button className="tool-btn primary" disabled={!name.trim()}><Icon name="plus" /> Создать проект</button></div></form>
      {view.page.items.length ? <ul className="project-cards">{view.page.items.map(project => <li key={project.id}>
        <span className="project-card-icon"><Icon name="folder" /></span><div><h2>{project.name}</h2><p>{roles[project.role]}</p><button className="tool-btn" onClick={() => selectProject(project)} aria-label={`Открыть проект ${project.name}`}>Открыть проект <Icon name="chevron" /></button></div>
      </li>)}</ul> : <div className="projects-empty"><Icon name="folder" /><h2>Здесь появятся ваши проекты</h2><p>Создайте первый проект или попросите владельца предоставить доступ.</p></div>}
      <div className="projects-pages"><button className="tool-btn" onClick={() => void refresh()}>Первая страница</button>
        {view.page.nextAfterId && <button className="tool-btn" onClick={nextPage}>Следующая страница <Icon name="chevron" /></button>}</div>
      <p className="projects-note">Существующие общие схемы доступны на вкладке «Рабочее пространство».</p></>}
    </div> : !view.busy && <div className="projects-login-layout"><div className="projects-login-copy"><span className="project-card-icon"><Icon name="folder" /></span>
      <h2>Войдите в своё пространство</h2><p>Проекты доступны владельцу и приглашённым участникам. Выход завершает текущую сессию; другие устройства продолжают работать.</p>
      <p>Учётную запись создаёт администратор установки.</p></div>
      <form className="projects-login" onSubmit={signIn}><h2>Вход в Enersy</h2><label htmlFor="account-login">Логин</label>
        <input id="account-login" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required maxLength={200} />
        <label htmlFor="account-password">Пароль</label><input id="account-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={1024} />
        <button className="tool-btn primary" disabled={!username.trim() || !password}>Войти</button></form></div>}
  </section>;
}
