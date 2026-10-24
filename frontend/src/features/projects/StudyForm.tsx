import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { createStudy, appendStudyVersion, readStudy, parseStudyDocument, StudyWriteError, type StudyDocument, type StudyVersion } from '../../api/studies-api';
import { readProjectScheme, SessionError, type Project } from '../../api/projects-api';
import { parseProjectGraph, type ProjectGraph } from './project-graph';
import { StudyDocumentView } from './StudyDocumentView';

type LimitDraft = { component: string; terminal: string; min: string; max: string };
type Attempt = { document: StudyDocument; command: string; expected?: string; topology: string };
export function StudyForm({ project, source, version, onSaved, onClose, onUnavailable }: {
  project: Project; source: ProjectGraph; version?: StudyVersion; onSaved: (v: StudyVersion) => void;
  onClose: () => void; onUnavailable?: () => void;
}) {
  const initial = version?.document;
  const [graph, setGraph] = useState(source);
  const [name, setName] = useState(initial?.name ?? '');
  const [backend, setBackend] = useState(initial?.computeBackend ?? 'julia');
  const [power, setPower] = useState(initial ? String(initial.base.s_base_mva) : '');
  const [voltage, setVoltage] = useState(initial ? String(initial.base.v_base_kv) : '');
  const [tolerance, setTolerance] = useState(String(initial?.solverOptions.tolerance ?? 1e-8));
  const [iterations, setIterations] = useState(String(initial?.solverOptions.max_iterations ?? 50));
  const [budget, setBudget] = useState(String(initial?.maxTimeMs ?? 20000));
  const [limits, setLimits] = useState<LimitDraft[]>(() => (initial?.operatingLimits ?? []).map(l => ({ component: String(l.component_id), terminal: String(l.terminal), min: String(l.min_kv), max: String(l.max_kv) })));
  const [expected, setExpected] = useState(version?.revision);
  const [latest, setLatest] = useState<StudyVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [controller] = useState(() => new AbortController());
  const dispatching = useRef(false);
  useEffect(() => () => controller.abort(), [controller]);
  const locked = busy || pending !== null;
  let document: StudyDocument | null = null;
  try {
    document = parseStudyDocument({ formatVersion: 1, name, modelGroup: 'three-phase', method: 'newton-raphson', computeBackend: backend,
      maxTimeMs: Number(budget), base: { s_base_mva: Number(power), v_base_kv: Number(voltage) },
      solverOptions: { tolerance: Number(tolerance), max_iterations: Number(iterations) },
      operatingLimits: limits.map(l => ({ component_id: Number(l.component), terminal: Number(l.terminal), min_kv: Number(l.min), max_kv: Number(l.max) })) });
    if (document.operatingLimits.some(l => !graph.components.some(c => c.id === l.component_id))) document = null;
  } catch { /* Incomplete fields remain editable and never dispatch. */ }
  const unavailable = (e: unknown) => {
    if (e instanceof SessionError && [401, 404].includes(e.status)) onUnavailable?.();
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (dispatching.current || project.role === 'viewer' || (!pending && !document)) return;
    const attempt = pending ?? { document: document!, command: crypto.randomUUID(), expected, topology: graph.topologyRevision };
    dispatching.current = true; setBusy(true); setError('');
    try {
      const saved = version
        ? await appendStudyVersion(project.id, version.id, attempt.expected!, attempt.topology, attempt.document, attempt.command, controller.signal)
        : await createStudy(project.id, graph.id, attempt.topology, attempt.document, attempt.command, controller.signal);
      if (!controller.signal.aborted) { setPending(null); onSaved(saved); }
    } catch (e) {
      if (!controller.signal.aborted) {
        const uncertain = !(e instanceof StudyWriteError) || e.status >= 500;
        setPending(uncertain ? attempt : null);
        setConflict(e instanceof StudyWriteError && e.code === 'study_revision_conflict');
        setError(uncertain ? 'Сохранение не подтверждено. Повторите ту же команду, чтобы проверить её исход; поля временно заблокированы.' :
          e instanceof StudyWriteError && e.code === 'study_revision_conflict' ? 'Другая сессия сохранила новую версию. Ваши настройки остались в форме.' :
          e instanceof StudyWriteError && e.code === 'study_source_conflict' ? 'Исходная схема изменилась. Прочитайте её заново перед сохранением.' :
          e instanceof StudyWriteError && e.status === 413 ? 'Достигнут предел размера или количества снимков проекта.' : 'Не удалось сохранить исследование. Проверьте настройки и доступ к исходной схеме.');
        unavailable(e);
      }
    } finally { dispatching.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  async function compare() {
    if (!version || busy) return;
    setBusy(true);
    try { const current = await readStudy(project.id, version.id, controller.signal); if (!controller.signal.aborted) setLatest(current); }
    catch (e) { if (!controller.signal.aborted) { setError('Не удалось прочитать актуальную версию. Ваш черновик сохранён в форме.'); unavailable(e); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function refreshSource() {
    if (locked) return;
    setBusy(true);
    try {
      const fresh = parseProjectGraph(await readProjectScheme(project.id, graph.id, controller.signal), project.id, graph.id);
      if (!controller.signal.aborted) { setGraph(fresh); setError('Источник обновлён. Проверьте оборудование и границы перед сохранением.'); }
    } catch (e) { if (!controller.signal.aborted) { setError('Исходная схема недоступна. Сохранённая история исследования остаётся отдельной.'); unavailable(e); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const changeLimit = (index: number, field: keyof LimitDraft, value: string) => setLimits(rows => rows.map((l, i) => i === index ? { ...l, [field]: value } : l));
  return <Dialog title={version ? `Новая версия исследования №${version.id}` : 'Сохранить исследование'} onClose={onClose} closeDisabled={locked} wide>
    <p className="dialog-intro">Будет захвачена сохранённая схема «{graph.name}»: {graph.components.length} объектов, {graph.connections.length} связей. Несохранённые правки редактора не входят в снимок. Сохранение не запускает расчёт.</p>
    <p className="projects-note">{expected ? `Ожидаемая версия исследования: ${expected}. ` : ''}Топология источника: {graph.topologyRevision}. Параметры оборудования фиксируются из сохранённой схемы в момент захвата.</p>
    <form className="scheme-form study-form" onSubmit={event => void save(event)}>
      <fieldset disabled={locked} className="study-form-fields"><legend>Настройки исследования</legend>
        <label>Название<input autoFocus required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
        <div className="study-form-grid">
          <label>Базис мощности, МВА<input required type="number" step="any" value={power} onChange={e => setPower(e.target.value)} /></label>
          <label>Базис напряжения, кВ<input required type="number" step="any" value={voltage} onChange={e => setVoltage(e.target.value)} /></label>
        </div>
        <label>Вычислительный движок<select value={backend} onChange={e => setBackend(e.target.value as StudyDocument['computeBackend'])}><option value="julia">Julia</option><option value="julia-rust-jacobian">Julia + Rust · экспериментальный</option></select></label>
        <details><summary>Параметры решателя · симметричный AC, Ньютон–Рафсон</summary><div className="study-form-grid">
          <label>Допуск невязки, p.u.<input required type="number" step="any" value={tolerance} onChange={e => setTolerance(e.target.value)} /></label>
          <label>Лимит итераций<input required type="number" min="1" max="1000" step="1" value={iterations} onChange={e => setIterations(e.target.value)} /></label>
          <label>Мягкий бюджет времени, мс<input required type="number" min="1" max="20000" step="1" value={budget} onChange={e => setBudget(e.target.value)} /></label>
        </div></details>
        <details open={limits.length > 0}><summary>Границы напряжения · {limits.length}</summary>
          <p className="projects-note">Линейное действующее напряжение, кВ. Номер терминала берётся из карты расчёта; физическая пригодность проверяется при расчёте.</p>
          {limits.map((l, index) => <fieldset className="study-limit-row" key={index}><legend>Граница {index + 1}</legend>
            <label>Объект<select aria-label={`Объект границы ${index + 1}`} value={l.component} onChange={e => changeLimit(index, 'component', e.target.value)}><option value="">Выберите оборудование</option>
              {l.component && !graph.components.some(c => String(c.id) === l.component) && <option value={l.component}>Объект #{l.component} отсутствует</option>}
              {graph.components.map(c => <option key={c.id} value={c.id}>{c.name || c.type} #{c.id}</option>)}</select></label>
            <label>Терминал<input aria-label={`Терминал границы ${index + 1}`} type="number" min="1" step="1" value={l.terminal} onChange={e => changeLimit(index, 'terminal', e.target.value)} /></label>
            <label>Минимум, кВ<input aria-label={`Минимум границы ${index + 1}`} type="number" step="any" value={l.min} onChange={e => changeLimit(index, 'min', e.target.value)} /></label>
            <label>Максимум, кВ<input aria-label={`Максимум границы ${index + 1}`} type="number" step="any" value={l.max} onChange={e => changeLimit(index, 'max', e.target.value)} /></label>
            <button type="button" className="tool-btn" onClick={() => setLimits(rows => rows.filter((_, i) => i !== index))}>Убрать границу {index + 1}</button>
          </fieldset>)}
          <button type="button" className="tool-btn" disabled={limits.length >= 1000 || !graph.components.length} onClick={() => setLimits(rows => [...rows, { component: '', terminal: '', min: '', max: '' }])}>Добавить границу исследования</button>
        </details>
      </fieldset>
      {!document && <p className="projects-note">Заполните название и положительные базисы. Границы должны быть полными, не повторяться и иметь минимум не выше максимума.</p>}
      {error && <p role="alert" className="projects-error">{error}</p>}
      {latest && <section className="study-comparison" aria-label="Сравнение версий"><h3>На сервере — версия {latest.revision}: {latest.document.name}</h3><StudyDocumentView document={latest.document} />
        <p>Ваши настройки остаются в форме выше.</p><button type="button" className="tool-btn" disabled={busy} onClick={() => { setExpected(latest.revision); setLatest(null); setConflict(false); setError('Ожидаемая версия обновлена. Проверьте форму и подтвердите сохранение своих настроек.'); }}>Продолжить с моими настройками после версии {latest.revision}</button>
      </section>}
      <div className="dialog-actions">
        {!pending && <button type="button" className="tool-btn" disabled={busy} onClick={onClose}>Отмена</button>}
        {!pending && <button type="button" className="tool-btn" disabled={busy} onClick={() => void refreshSource()}>Прочитать схему заново</button>}
        {conflict && <button type="button" className="tool-btn" disabled={busy} onClick={() => void compare()}>Сравнить с актуальной версией</button>}
        {pending && <button type="button" className="tool-btn" disabled={busy} onClick={onClose}>Закрыть и проверить историю</button>}
        <button className="tool-btn primary" disabled={busy || (!pending && !document)}>{busy ? 'Сохраняем снимок…' : pending ? 'Повторить ту же команду' : 'Сохранить снимок'}</button>
      </div>
      {pending && <p className="projects-note">После закрытия или перезагрузки проверьте список исследований и историю: команда могла выполниться. Автоматического повторного создания нет.</p>}
    </form>
  </Dialog>;
}
