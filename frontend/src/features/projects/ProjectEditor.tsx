import { useEffect, useRef, useState } from 'react';
import { SchemeEditor } from '../../components/ees/SchemeEditor';
import { ComponentWrites } from '../../components/ees/component-writes';
import type { SchemeTransport } from '../../components/ees/scheme-transport';
import type { Identity, Project } from '../../api/projects-api';
import type { ProjectCalculation } from '../../api/project-scheme-api';
import type { ProjectGraph } from './project-graph';
import { captureEditorComponents, restoreProjectEditorJournal } from './editor-journal';
import { createComponentIntentJournal } from './component-intent-journal';
import { createEquipmentIntentJournal } from './equipment-intent-journal';
import { createLoadFormDraftJournal } from './load-form-draft-journal';
import { LoadFormDraftContext, type LoadFormDraftStore } from '../../components/ees/panels/load-form-draft-context';
import { ParameterFormDraftContext, type ParameterFormDraftStore } from '../../components/ees/panels/parameter-form-draft-context';
import { createParameterFormDraftJournal } from './parameter-form-draft-journal';

type Context = { generation: number; controller: AbortController; queue: ComponentWrites; transport: SchemeTransport; forms: LoadFormDraftStore; parameterForms: ParameterFormDraftStore };
export function ProjectEditor({ identity, project, graph, onClose, onUnavailable }: {
  identity: Identity; project: Project; graph: ProjectGraph; onClose: () => void; onUnavailable?: () => void;
}) {
  const [context, setContext] = useState<Context | null>(null);
  const [source, setSource] = useState<ProjectCalculation['source'] | null>(null);
  const [closing, setClosing] = useState(false);
  const [openingError, setOpeningError] = useState('');
  const [journalError, setJournalError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    setOpeningError(''); setJournalError('');
    try {
      const journal = createEquipmentIntentJournal({ ...identity, projectId: project.id, schemeId: graph.id });
      const pending = journal.read();
      const componentJournal = createComponentIntentJournal({ ...identity, projectId: project.id, schemeId: graph.id });
      const componentDrafts = componentJournal.read();
      const { queue, transport } = restoreProjectEditorJournal({ identity: { accountId: identity.accountId, sessionId: identity.sessionId }, projectId: project.id, schemeId: graph.id, name: graph.name,
        onPreparedEquipment: intent => { controller.signal.throwIfAborted(); journal.prepare(intent); },
        onResolvedEquipment: command => { controller.signal.throwIfAborted(); journal.resolve(command); },
        writable: project.role !== 'viewer', signal: controller.signal,
        onUnavailable: () => { controller.abort(); setContext(null); setSource(null); setUnavailable(true); onUnavailable?.(); },
        onCalculation: value => { if (!controller.signal.aborted) setSource(value); },
      }, { formatVersion: 1, components: componentDrafts.components, graph: pending.map(intent => ({ intent, reason: 'После открытия проверьте исход сохранённой команды создания' })) });
      queue.persistDraftsWith(() => {
        controller.signal.throwIfAborted();
        componentJournal.save({ formatVersion: 2, components: captureEditorComponents(queue, graph.id), graph: [] });
        setJournalError('');
      }, error => { if (!controller.signal.aborted) setJournalError(error instanceof Error ? error.message : 'Не удалось обновить локальный журнал правок.'); });
      setSource(null); setClosing(false); setUnavailable(false);
      setContext({ generation: ++generation.current, controller, queue, transport,
        forms: createLoadFormDraftJournal({ ...identity, projectId: project.id, schemeId: graph.id }, controller.signal),
        parameterForms: createParameterFormDraftJournal({ ...identity, projectId: project.id, schemeId: graph.id }, controller.signal) });
    } catch (error) { controller.abort(); setContext(null); setOpeningError(error instanceof Error ? error.message : 'Не удалось открыть локальный журнал'); }
    return () => controller.abort();
  }, [identity.accountId, identity.sessionId, project.id, project.role, graph.id, graph.name, onUnavailable]);
  const close = async () => {
    if (!context || closing) return;
    setClosing(true);
    await Promise.all([context.queue.settle(), context.queue.graph.settle(Number(graph.id))]);
    if (context.controller.signal.aborted) return;
    if ((context.queue.drafts.hasFailed(Number(graph.id)) || context.queue.graph.failed(Number(graph.id)).length) &&
        !window.confirm('Есть неподтверждённые изменения. Команды создания и правки оборудования сохранятся в этой вкладке, если журнал доступен. Остальные локальные изменения топологии будут потеряны. Выполненные записи на сервере останутся. Закрыть редактор?')) {
      setClosing(false); return;
    }
    context.controller.abort(); setSource(null); onClose();
  };
  return <section className="project-editor" aria-label={`Редактор проекта ${project.name}`}>
    <div className="projects-session"><div><span className="eyebrow">{project.name}</span><h2>{graph.name}</h2></div>
      <button className="tool-btn" disabled={closing} onClick={() => unavailable || openingError ? onClose() : void close()}>{closing ? 'Ожидаем подтверждений…' : 'Закрыть редактор'}</button></div>
    {journalError && <p role="alert">{journalError} Сохраните вкладку открытой и проверьте журнал перед выходом.</p>}
    {openingError ? <p role="alert">{openingError}</p> : unavailable ? <p role="alert">Доступ к схеме завершён. Проверьте сессию и права проекта.</p> : context && !context.controller.signal.aborted ?
      <div className="project-editor-body" aria-busy={closing} onKeyDownCapture={event => { if (closing) { event.preventDefault(); event.stopPropagation(); } }}>
        <LoadFormDraftContext.Provider value={context.forms}>
          <ParameterFormDraftContext.Provider value={context.parameterForms}>
            <SchemeEditor key={context.generation} schemeId={Number(graph.id)} writeQueue={context.queue} transport={context.transport} manageSchemes={false} />
          </ParameterFormDraftContext.Provider>
        </LoadFormDraftContext.Provider>
      </div> : <p role="status">Открываем редактор…</p>}
    <p className="projects-note">Успешный расчёт сохраняется в архив проекта. Архив доступен в навигаторе схем. После потери подтверждения проверьте архив перед повторным запуском.</p>
    {source && <p className="project-editor-source">Последний расчёт{source.archiveId ? ` · архив №${source.archiveId}` : ''}: ревизия топологии {source.topologyRevision} · <span title={source.inputSha256}>SHA-256 {source.inputSha256.slice(0, 16)}…</span></p>}
  </section>;
}
