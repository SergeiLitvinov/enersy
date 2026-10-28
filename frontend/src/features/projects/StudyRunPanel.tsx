import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createStudyRun, isActiveRun, listStudyRuns, readStudyRun, RunRequestError, type RunErrorCode, type RunStatus, type StudyRun } from '../../api/study-runs-api';
import { readCalculationArchive, type OpenCalculationArchive } from '../../api/calculation-archives-api';
import { SessionError, type Identity, type Project } from '../../api/projects-api';
import type { StudyVersion } from '../../api/studies-api';
import { createRunIntentJournal } from './run-intent-journal';
import { ArchiveResultView } from './ArchiveResultView';
import './StudyRunPanel.css';

type Props={version:StudyVersion; identity:Identity; project:Project; onUnavailable:()=>void};
const labels:Record<RunStatus,string>={queued:'В очереди',validating:'Проверка входа',initializing:'Подготовка исполнителя',running:'Расчёт выполняется',succeeded:'Результат сохранён',failed:'Запуск завершился с ошибкой'};
const reasons:Record<RunErrorCode,string>={worker_unavailable:'Вычислительный сервис недоступен.',worker_transport:'Результат не опубликован: обмен с исполнителем не завершён.',worker_rejected:'Решатель отклонил вход или выбранный метод.',invalid_result:'Ответ решателя не прошёл проверку.',archive_quota:'Не удалось сохранить результат: достигнут лимит архива.',lease_exhausted:'Исполнитель не завершил задание после повторных доставок.',invalid_snapshot:'Не удалось проверить сохранённый вход.'};
const date=new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short'});
export function StudyRunPanel(props:Props){
  if(props.project.id!==props.version.projectId)return <p role="alert" className="projects-error">Версия исследования не относится к выбранному проекту.</p>;
  return <RunPanel key={`${props.identity.accountId}:${props.identity.sessionId}:${props.project.id}:${props.project.role}:${props.version.id}:${props.version.revision}`} {...props}/>;
}
function RunPanel({version,identity,project,onUnavailable}:Props){
  const target=useMemo(()=>({projectId:version.projectId,id:version.id,revision:version.revision,inputSha256:version.inputSha256,provenanceSha256:version.provenanceSha256}),[version.projectId,version.id,version.revision,version.inputSha256,version.provenanceSha256]);
  const journal=useMemo(()=>createRunIntentJournal(target,{accountId:identity.accountId,sessionId:identity.sessionId}),[target,identity.accountId,identity.sessionId]);
  const loadJournal=()=>{try{return {intent:journal.read(),error:''};}catch{return {intent:null,error:'Локальная команда недоступна или повреждена. Проверьте историю перед новым запуском.'};}};
  const [pending,setPending]=useState(loadJournal);
  const [items,setItems]=useState<StudyRun[]>([]),[cursor,setCursor]=useState(''),[next,setNext]=useState('');
  const [historyReload,setHistoryReload]=useState(0),[historyBusy,setHistoryBusy]=useState(true),[historyError,setHistoryError]=useState('');
  const [selected,setSelected]=useState(''),[run,setRun]=useState<StudyRun|null>(null),[monitorRetry,setMonitorRetry]=useState(0),[monitorError,setMonitorError]=useState('');
  const [submitting,setSubmitting]=useState(false),[submitError,setSubmitError]=useState('');
  const [archive,setArchive]=useState<OpenCalculationArchive|null>(null),[archiveBusy,setArchiveBusy]=useState(false),[archiveError,setArchiveError]=useState('');
  const selection=useRef(''),writing=useRef(false),write=useRef<AbortController|null>(null),opening=useRef<AbortController|null>(null);
  useEffect(()=>()=>{write.current?.abort();opening.current?.abort();},[]);
  const denied=useCallback((error:unknown)=>{
    if((error instanceof SessionError && [401,403,404].includes(error.status)) || (error instanceof RunRequestError && error.code==='run_session_changed')){setItems([]);setRun(null);setArchive(null);onUnavailable();return true;}
    return false;
  },[onUnavailable]);
  const choose=useCallback((value:StudyRun)=>{opening.current?.abort();setArchive(null);setArchiveError('');setArchiveBusy(false);selection.current=value.id;setSelected(value.id);setRun(value);setMonitorRetry(n=>n+1);},[]);
  useEffect(()=>{
    const controller=new AbortController();setHistoryBusy(true);setHistoryError('');setItems([]);setNext('');
    void listStudyRuns(target,controller.signal,cursor).then(page=>{
      if(controller.signal.aborted)return;
      setItems(page.items);setNext(page.next);
      if(!selection.current && page.items.length)choose(page.items[0]);
    }).catch((error:unknown)=>{if(!controller.signal.aborted && !denied(error))setHistoryError(error instanceof Error?error.message:'История запусков недоступна');})
      .finally(()=>{if(!controller.signal.aborted)setHistoryBusy(false);});
    return ()=>controller.abort();
  },[target,cursor,historyReload,denied,choose]);
  useEffect(()=>{
    if(!selected)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    setMonitorError('');
    const poll=async()=>{
      try{
        const value=await readStudyRun(target,selected,controller.signal);
        if(controller.signal.aborted)return;
        setRun(value);
        if(isActiveRun(value))timer=setTimeout(()=>void poll(),1000);
        else setHistoryReload(n=>n+1);
      }catch(error){if(!controller.signal.aborted && !denied(error))setMonitorError('Состояние запуска не подтверждено. Повторите проверку; новая команда не создаётся.');}
    };
    void poll();return ()=>{controller.abort();if(timer!==undefined)clearTimeout(timer);};
  },[target,selected,monitorRetry,denied]);
  async function submit(){
    if(writing.current || project.role==='viewer' || pending.error)return;
    writing.current=true;setSubmitting(true);setSubmitError('');
    const controller=new AbortController();write.current=controller;
    let prepared=false,confirmed=false;
    try{
      const intent=journal.prepare(pending.intent?.command??crypto.randomUUID());prepared=true;setPending(loadJournal());
      const accepted=await createStudyRun(target,intent.command,identity,controller.signal);
      if(controller.signal.aborted)return;
      confirmed=true;
      choose(accepted);journal.clear(intent.command);setPending(loadJournal());setCursor('');setHistoryReload(n=>n+1);
    }catch(error){if(!controller.signal.aborted){setPending(loadJournal());if(!denied(error))setSubmitError(confirmed
      ?'Запуск принят, но локальная запись команды недоступна. Проверьте историю запусков.'
      :prepared && !(error instanceof RunRequestError)
        ?'Подтверждение запуска не получено. Проверьте прежнюю команду, чтобы не создать повторный расчёт.'
        :error instanceof Error?error.message:'Не удалось подготовить команду запуска.');}}
    finally{writing.current=false;if(!controller.signal.aborted)setSubmitting(false);}
  }
  async function openArchive(){
    if(!run?.archiveId)return;
    opening.current?.abort();const controller=new AbortController();opening.current=controller;setArchiveBusy(true);setArchiveError('');
    try{
      const value=await readCalculationArchive(project.id,run.archiveId,controller.signal);
      if(controller.signal.aborted)return;
      if(value.metadata.inputSha256!==version.inputSha256 || value.metadata.provenanceSha256!==version.provenanceSha256 || value.metadata.schemeId!==version.schemeId || value.metadata.topologyRevision!==version.topologyRevision)throw new Error('Архив не соответствует выбранной версии Study');
      setArchive(value);
    }catch(error){if(!controller.signal.aborted && !denied(error))setArchiveError(error instanceof Error?error.message:'Архив недоступен');}
    finally{if(!controller.signal.aborted)setArchiveBusy(false);}
  }
  return <section className="study-runs" aria-label={`Запуски версии ${version.revision}`}>
    <header className="study-run-heading"><div><span className="eyebrow">Сохранённая версия {version.revision}</span><h4>Расчёты исследования</h4></div>
      {project.role!=='viewer' && <button className="tool-btn primary" disabled={submitting || !!pending.intent || !!pending.error} onClick={()=>void submit()}>Запустить версию {version.revision}</button>}
    </header>
    <p className="projects-note">Исполнитель использует сохранённые сеть и настройки. Изменение текущей схемы, закрытие вкладки и выход из аккаунта не отменяют принятый запуск.</p>
    {project.role==='viewer' && <p className="projects-note">Доступно только чтение запусков и результатов.</p>}
    {(pending.intent || pending.error) && <div className="study-run-recovery" role="status"><strong>Есть неподтверждённая команда запуска</strong><p>{pending.error || 'Повторная проверка использует тот же идентификатор. Если команда ещё не дошла до сервера, она будет поставлена в очередь.'}</p>
      {pending.intent && <button className="tool-btn" disabled={submitting || project.role==='viewer'} onClick={()=>void submit()}>Проверить прежнюю команду</button>}
      <button className="tool-btn" disabled={submitting} onClick={()=>{if(window.confirm('Забыть локальную команду? Это не отменяет запуск на сервере. Сначала проверьте историю запусков.')){try{journal.discard();setPending(loadJournal());setSubmitError('');}catch{setSubmitError('Не удалось очистить локальную команду.');}}}}>Забыть локальную команду</button>
    </div>}
    {submitting && <p role="status">Проверяем принятие команды…</p>}
    {submitError && <p role="alert" className="projects-error">{submitError}</p>}
    {run && <div className="study-run-monitor" aria-label={`Запуск №${run.id}`}>
      <div className="study-run-heading"><strong>Запуск №{run.id}</strong><span className="study-run-state" data-status={run.status}>{labels[run.status]}</span></div>
      <p className="projects-note">{date.format(new Date(run.createdAt))} · автор №{run.requestedBy}</p>
      {isActiveRun(run) && <p className="projects-note">Состояние обновляется автоматически. Отмена и пауза пока недоступны.</p>}
      {run.errorCode && <p role="alert" className="projects-error">{reasons[run.errorCode]}</p>}
      {monitorError && <p role="alert" className="projects-error">{monitorError} Показано последнее известное состояние.</p>}
      <div className="study-actions"><button className="tool-btn" onClick={()=>setMonitorRetry(n=>n+1)}>Проверить состояние</button>
        {run.archiveId && <button className="tool-btn primary" disabled={archiveBusy} onClick={()=>void openArchive()}>{archiveBusy?'Открываем результат…':'Открыть результат'}</button>}</div>
      {archiveError && <p role="alert" className="projects-error">{archiveError}</p>}
    </div>}
    <div className="study-run-heading"><h4>История запусков версии</h4><button className="tool-btn" disabled={historyBusy} onClick={()=>setHistoryReload(n=>n+1)}>Обновить историю запусков</button></div>
    {historyError && <p role="alert" className="projects-error">{historyError}</p>}
    {historyBusy?<p role="status">Загружаем запуски…</p>:<>
      {!items.length && !historyError && <p className="projects-empty">У этой версии пока нет запусков.</p>}
      <ul className="study-run-history">{items.map(item=><li key={item.id}><button className="study-run-card" aria-pressed={selected===item.id} disabled={submitting} onClick={()=>choose(item)}><strong>№{item.id}</strong><span>{labels[item.id===run?.id?run.status:item.status]}</span><small>{date.format(new Date(item.createdAt))}</small></button></li>)}</ul>
      <div className="study-actions">{cursor && <button className="tool-btn" onClick={()=>setCursor('')}>Последние запуски</button>}{next && <button className="tool-btn" onClick={()=>setCursor(next)}>Более ранние запуски</button>}</div>
    </>}
    {archive && <ArchiveResultView archive={archive} onClose={()=>{opening.current?.abort();setArchive(null);}}/>}
  </section>;
}
