import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listStudies, listStudyVersions, readStudy, type StudyVersion } from '../../api/studies-api';
import { readProjectScheme, SessionError, type Project, type Identity } from '../../api/projects-api';
import { parseProjectGraph, type ProjectGraph } from './project-graph';
import { readStudySnapshot, type StudySnapshot } from './study-snapshot';
import { StudyDocumentView } from './StudyDocumentView';
import { StudyForm } from './StudyForm';
import { ArchiveInputs } from './ArchiveInputs';
import { createStudyIntentJournal } from './study-intent-journal';
import { StudyIntentRecovery } from './StudyIntentRecovery';
import './ProjectArchives.css';
import './ProjectStudies.css';

type Props = { project: Project; identity: Identity; source?: ProjectGraph; autoCreate?: boolean; onBack: () => void; onUnavailable?: () => void };
type Form = { source: ProjectGraph; version?: StudyVersion };
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
export function ProjectStudies(props: Props) { return <StudyList key={`${props.identity.accountId}:${props.identity.sessionId}:${props.project.id}:${props.project.role}`} {...props} />; }
function StudyList({ project, identity, source, autoCreate, onBack, onUnavailable }: Props) {
  const writable = project.role !== 'viewer';
  const journal = useMemo(() => createStudyIntentJournal({ accountId: identity.accountId, sessionId: identity.sessionId, projectId: project.id }), [identity.accountId, identity.sessionId, project.id]);
  const loadJournal = () => { try { return { intent: journal.read(), error: '' }; } catch { return { intent: null, error: 'Локальная запись команды недоступна или повреждена. Новое сохранение заблокировано до проверки журнала вкладки.' }; } };
  const [recovery, setRecovery] = useState(loadJournal);
  const [items, setItems] = useState<StudyVersion[]>([]), [cursor, setCursor] = useState(''), [next, setNext] = useState('');
  const [reload, refresh] = useState(0), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [opened, setOpened] = useState<StudyVersion | null>(null), [snapshot, setSnapshot] = useState<StudySnapshot | null>(null);
  const [history, setHistory] = useState<StudyVersion[]>([]), [historyCursor, setHistoryCursor] = useState(''), [historyNext, setHistoryNext] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false), [historyError, setHistoryError] = useState('');
  const [action, setAction] = useState('');
  const [form, setForm] = useState<Form | null>(() => autoCreate && writable && !recovery.intent && !recovery.error && source?.projectId === project.id ? { source } : null);
  const command = useRef<AbortController | null>(null);
  const denied = useRef(false);
  useEffect(() => () => command.current?.abort(), []);
  const clearPrivate = useCallback(() => {
    denied.current = true; command.current?.abort(); setItems([]); setNext(''); setOpened(null); setSnapshot(null); setHistory([]); setForm(null); setAction(''); onUnavailable?.();
  }, [onUnavailable]);
  const unavailable = useCallback((e: unknown) => {
    if (e instanceof SessionError && [401, 404].includes(e.status)) {
      clearPrivate();
    }
  }, [clearPrivate]);
  // Reads are scoped to this mounted project/role; refresh does not silently replace an acknowledged version.
  useEffect(() => {
    const c = new AbortController(); setBusy(true); setItems([]); setNext(''); setError('');
    void listStudies(project.id, c.signal, cursor).then(p => { if (!c.signal.aborted && !denied.current) { setItems(p.items); setNext(p.next); } }).catch(e => {
      if (!c.signal.aborted) { setError(e instanceof Error ? e.message : 'Исследования недоступны'); unavailable(e); }
    }).finally(() => { if (!c.signal.aborted) setBusy(false); });
    return () => c.abort();
  }, [project.id, cursor, reload, unavailable]);
  const studyId = opened?.id;
  useEffect(() => {
    const c = new AbortController(); setHistory([]); setHistoryNext(''); setHistoryError('');
    if (!studyId) { setHistoryBusy(false); return () => c.abort(); }
    setHistoryBusy(true);
    void listStudyVersions(project.id, studyId, c.signal, historyCursor).then(p => {
      if (!c.signal.aborted && !denied.current) { setHistory(p.items); setHistoryNext(p.next); }
    }).catch(e => { if (!c.signal.aborted) { setHistoryError(e instanceof Error ? e.message : 'История недоступна'); unavailable(e); } })
      .finally(() => { if (!c.signal.aborted) setHistoryBusy(false); });
    return () => c.abort();
  }, [project.id, studyId, historyCursor, reload, unavailable]);
  function begin(label: string) {
    command.current?.abort(); const c = new AbortController(); command.current = c; setAction(label); setError(''); return c;
  }
  async function open(id: string, revision?: string) {
    const c = begin('Открываем версию…'); setSnapshot(null); setOpened(null);
    try { const v = await readStudy(project.id, id, c.signal, revision); if (!c.signal.aborted && !denied.current) { setHistoryCursor(''); setOpened(v); } }
    catch (e) { if (!c.signal.aborted) { setError(e instanceof Error ? e.message : 'Версия недоступна'); unavailable(e); } }
    finally { if (!c.signal.aborted) setAction(''); }
  }
  async function inspect() {
    if (!opened) return;
    const c = begin('Проверяем и читаем снимок…'); setSnapshot(null);
    try { const v = await readStudySnapshot(project.id, opened, c.signal); if (!c.signal.aborted && !denied.current) setSnapshot(v); }
    catch (e) { if (!c.signal.aborted) { setError(e instanceof Error ? e.message : 'Снимок недоступен'); unavailable(e); } }
    finally { if (!c.signal.aborted) setAction(''); }
  }
  async function edit() {
    if (!opened || !writable) return;
    const c = begin('Читаем текущую сохранённую схему…');
    try {
      const graph = parseProjectGraph(await readProjectScheme(project.id, opened.schemeId, c.signal), project.id, opened.schemeId);
      if (!c.signal.aborted && !denied.current) setForm({ source: graph, version: opened });
    } catch (e) {
      if (!c.signal.aborted) {
        setError('Исходная схема недоступна. Историю и сохранённый снимок можно просматривать независимо от неё.');
        if (e instanceof SessionError && e.status === 401) unavailable(e);
      }
    } finally { if (!c.signal.aborted) setAction(''); }
  }
  function saved(v: StudyVersion) { if (denied.current) return; setRecovery(loadJournal()); setForm(null); setSnapshot(null); setOpened(v); setCursor(''); setHistoryCursor(''); refresh(n => n + 1); }
  if (denied.current) return <section className="project-studies"><p role="alert" className="projects-error">Доступ к исследованиям требует повторной проверки сессии и прав.</p><button className="tool-btn" onClick={onBack}>Вернуться</button></section>;
  return <section className="project-studies" aria-label={`Исследования проекта ${project.name}`}>
    <div className="projects-session"><div><span className="eyebrow">{project.name}</span><h2>Исследования</h2></div><div className="study-actions">
      <button className="tool-btn" onClick={onBack}>К схемам проекта</button><button className="tool-btn" disabled={busy || !!action} onClick={() => refresh(n => n + 1)}>Обновить исследования</button>
      {writable && <button className="tool-btn primary" disabled={!source || source.projectId !== project.id || !!action || !!recovery.intent || !!recovery.error} onClick={() => { if (source) setForm({ source }); }}>Новое исследование</button>}
    </div></div>
    <p className="projects-note">Исследование хранит версии сети и настроек отдельно от текущей схемы. Сохранение снимка не запускает расчёт. {writable && (source ? `Источник нового исследования: «${source.name}».` : 'Для нового исследования сначала выберите схему проекта.')}</p>
    {error && <p role="alert" className="projects-error">{error}</p>}
    {recovery.error && <div className="projects-error" role="alert"><p>{recovery.error}</p><button className="tool-btn" onClick={() => {
      if (window.confirm('Удалить повреждённую локальную запись? Команда могла выполниться на сервере; удаление журнала не отменяет её. Сначала проверьте историю.')) {
        try { journal.discard(); setRecovery(loadJournal()); } catch { /* Keep the visible error and write barrier. */ }
      }
    }}>Удалить повреждённую локальную запись</button></div>}
    {recovery.intent && <StudyIntentRecovery key={recovery.intent.command} intent={recovery.intent} journal={journal} writable={writable} onResolved={saved} onDiscarded={() => setRecovery(loadJournal())} onUnavailable={clearPrivate} />}
    {action && <p role="status">{action}</p>}
    <div className="study-layout"><nav aria-label="Список исследований">
      {busy ? <p role="status">Загружаем исследования…</p> : <>
        {!items.length && !error && <p className="projects-empty">На этой странице пока нет исследований.</p>}
        <ul className="study-cards">{items.map(v => <li key={v.id}><button className="study-card" aria-pressed={opened?.id === v.id} disabled={!!action} onClick={() => void open(v.id, v.revision)}>
          <span className="eyebrow">№{v.id} · версия {v.revision}</span><strong>{v.document.name}</strong><span>{v.schemeName}</span><small>{date.format(new Date(v.createdAt))}</small>
        </button></li>)}</ul>
        <div className="study-actions"><button className="tool-btn" disabled={!cursor || !!action} onClick={() => setCursor('')}>Начало списка</button>{next && <button className="tool-btn" disabled={!!action} onClick={() => setCursor(next)}>Следующие исследования</button>}</div>
      </>}
    </nav><div aria-label="Выбранная версия исследования" className="study-detail">
      {opened ? <>
        <div className="study-detail-heading"><span className="study-status">Снимок сохранён · расчёт не выполнялся</span><h3>{opened.document.name}</h3><p>Исследование №{opened.id} · версия {opened.revision}</p></div>
        <p className="projects-note">{date.format(new Date(opened.createdAt))} · автор №{opened.authorAccountId}. Источник: «{opened.schemeName}» №{opened.schemeId}, топология {opened.topologyRevision}.</p>
        <StudyDocumentView document={opened.document} />
        <div className="study-actions"><button className="tool-btn primary" disabled={!!action} onClick={() => void inspect()}>Просмотреть сохранённый снимок</button>
          {writable && <button className="tool-btn" disabled={!!action || !!recovery.intent || !!recovery.error} onClick={() => void edit()}>Создать новую версию</button>}
        </div>
        <p className="projects-note">Новая версия захватывает текущую сохранённую схему с настройками выбранной версии. Запуск выбранного снимка ещё разрабатывается.</p>
        <details className="study-hashes"><summary>Контрольные суммы и размеры</summary><dl><dt>Вход · {opened.inputBytes} байт</dt><dd>{opened.inputSha256}</dd><dt>Происхождение · {opened.provenanceBytes} байт</dt><dd>{opened.provenanceSha256}</dd></dl></details>
        <section aria-label="История исследования" className="study-history"><h4>История версий</h4>
          {historyError && <p role="alert">{historyError}</p>}{historyBusy ? <p role="status">Читаем историю…</p> : <ul>{history.map(v => <li key={v.revision}><button className="tool-btn" disabled={!!action} aria-pressed={v.revision === opened.revision} onClick={() => void open(v.id, v.revision)}>Версия {v.revision} · {v.document.name}</button><small>{date.format(new Date(v.createdAt))} · автор №{v.authorAccountId}</small></li>)}</ul>}
          <div className="study-actions"><button className="tool-btn" disabled={!historyCursor || historyBusy || !!action} onClick={() => setHistoryCursor('')}>Первые версии</button>{historyNext && <button className="tool-btn" disabled={historyBusy || !!action} onClick={() => setHistoryCursor(historyNext)}>Следующие версии</button>}</div>
        </section>
        {snapshot && <section className="study-snapshot" aria-label="Сохранённые входные данные"><h4>Снимок версии {opened.revision}</h4><p className="projects-note">SHA-256, размеры и привязка к версии проверены. Оборудование и происхождение прочитаны из снимка без обращения к текущей схеме и каталогу.</p><ArchiveInputs key={`${opened.id}:${opened.revision}`} input={snapshot.input} provenance={snapshot.provenance} /></section>}
      </> : <p className="projects-empty">Выберите исследование, чтобы увидеть настройки, историю и сохранённые данные.</p>}
    </div></div>
    {form && <StudyForm journal={journal} project={project} source={form.source} version={form.version} onClose={() => { setForm(null); setRecovery(loadJournal()); refresh(n => n + 1); }} onSaved={saved} onUnavailable={clearPrivate} />}
  </section>;
}
