// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {StudyRunPanel} from './StudyRunPanel';
import {cancelQueuedStudyRun,createStudyRun,listStudyRuns,readStudyRun,RunRequestError,type StudyRun} from '../../api/study-runs-api';
import {createRunCancellationJournal,createRunIntentJournal} from './run-intent-journal';
import {SessionError,type Project} from '../../api/projects-api';
import type {StudyVersion} from '../../api/studies-api';
import {readCalculationArchive,type OpenCalculationArchive} from '../../api/calculation-archives-api';
vi.mock('../../api/calculation-archives-api',()=>({readCalculationArchive:vi.fn()}));
vi.mock('../../api/study-runs-api',async original=>({...await original<typeof import('../../api/study-runs-api')>(),cancelQueuedStudyRun:vi.fn(),createStudyRun:vi.fn(),listStudyRuns:vi.fn(),readStudyRun:vi.fn()}));
vi.mock('./ArchiveResultView',()=>({ArchiveResultView:()=> <div role="dialog">Архив</div>}));
const identity={accountId:'1',sessionId:'2',expiresAt:'2099-01-01T00:00:00Z'};
const project:Project={id:'8',name:'Проект',role:'owner'};
const version:StudyVersion={status:'captured',id:'3',projectId:'8',schemeId:'7',revision:'2',authorAccountId:'1',topologyRevision:'1',schemeName:'Источник',createdAt:'2026-10-28T00:00:00Z',inputSha256:'a'.repeat(64),provenanceSha256:'b'.repeat(64),inputBytes:1,provenanceBytes:1,document:{formatVersion:1,name:'Исследование',modelGroup:'three-phase',method:'newton-raphson',computeBackend:'julia',maxTimeMs:20000,base:{s_base_mva:1,v_base_kv:1},solverOptions:{tolerance:1e-8,max_iterations:50},operatingLimits:[]}};
const target={projectId:'8',id:'3',revision:'2',inputSha256:version.inputSha256,provenanceSha256:version.provenanceSha256};
const run:StudyRun={id:'9007199254740993',projectId:'8',studyId:'3',studyRevision:'2',requestedBy:'1',status:'succeeded',archiveId:'4',inputSha256:version.inputSha256,provenanceSha256:version.provenanceSha256,createdAt:version.createdAt};
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
const unavailable=vi.fn();
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
beforeEach(()=>{vi.resetAllMocks();sessionStorage.clear();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');root=createRoot(host);vi.mocked(listStudyRuns).mockResolvedValue({items:[],next:''});vi.mocked(readStudyRun).mockResolvedValue(run);vi.mocked(createStudyRun).mockResolvedValue(run);});
afterEach(async()=>{await act(async()=>root.unmount());});
const mount=(p=project,v=version,i=identity)=>act(async()=>root.render(<StudyRunPanel project={p} version={v} identity={i} onUnavailable={unavailable}/>));

const queued:StudyRun={...run,status:'queued',archiveId:undefined};
const cancelled:StudyRun={...queued,status:'cancelled'};
function queuedHistory(){vi.mocked(listStudyRuns).mockResolvedValue({items:[queued],next:''});vi.mocked(readStudyRun).mockResolvedValue(queued);}

test('queued cancellation is explicit, single-dispatch and terminal without an archive',async()=>{
  queuedHistory();vi.mocked(cancelQueuedStudyRun).mockImplementation(async()=>{vi.mocked(readStudyRun).mockResolvedValue(cancelled);return cancelled;});
  await mount();expect(cancelQueuedStudyRun).not.toHaveBeenCalled();
  const cancelButton=button('Отменить до начала');
  await act(async()=>{cancelButton.click();cancelButton.click();});
  expect(cancelQueuedStudyRun).toHaveBeenCalledTimes(1);
  expect(cancelQueuedStudyRun).toHaveBeenCalledWith(target,run.id,expect.any(String),identity,expect.any(AbortSignal));
  expect(host.textContent).toContain('Отменён до начала исполнения');expect(button('Открыть результат')).toBeUndefined();
  expect(createRunCancellationJournal(target,identity).read()).toBeNull();expect(createStudyRun).not.toHaveBeenCalled();
});

test('an older queued monitor reply cannot overwrite the confirmed cancellation',async()=>{
  queuedHistory();let finish!:(value:StudyRun)=>void;
  vi.mocked(readStudyRun).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  vi.mocked(cancelQueuedStudyRun).mockImplementationOnce(async()=>{vi.mocked(readStudyRun).mockResolvedValue(cancelled);return cancelled;});
  await mount();const previous=vi.mocked(readStudyRun).mock.calls[0][2];
  await act(async()=>button('Отменить до начала').click());
  expect(previous.aborted).toBe(true);
  await act(async()=>finish(queued));
  expect(host.textContent).toContain('Отменён до начала исполнения');
  expect(button('Отменить до начала')).toBeUndefined();
});

test('lost cancellation acknowledgement survives remount with the same run and command and no automatic POST',async()=>{
  queuedHistory();vi.mocked(cancelQueuedStudyRun).mockRejectedValueOnce(new Error('Lost reply'));
  await mount();await act(async()=>button('Отменить до начала').click());
  const original=vi.mocked(cancelQueuedStudyRun).mock.calls[0];
  expect(createRunCancellationJournal(target,identity).read()?.runId).toBe(run.id);
  await act(async()=>root.render(<div/>));await mount();expect(cancelQueuedStudyRun).toHaveBeenCalledTimes(1);
  vi.mocked(cancelQueuedStudyRun).mockImplementationOnce(async()=>{vi.mocked(readStudyRun).mockResolvedValue(cancelled);return cancelled;});
  await act(async()=>button('Проверить прежнюю отмену').click());
  expect(vi.mocked(cancelQueuedStudyRun).mock.calls[1].slice(0,4)).toEqual(original.slice(0,4));
  expect(createRunCancellationJournal(target,identity).read()).toBeNull();
});

test('a claimed run rejects queued cancellation, clears its command and refreshes state',async()=>{
  queuedHistory();vi.mocked(cancelQueuedStudyRun).mockImplementationOnce(async()=>{vi.mocked(readStudyRun).mockResolvedValue({...queued,status:'running'});throw new RunRequestError(409,'Already claimed','run_already_claimed');});
  await mount();await act(async()=>button('Отменить до начала').click());
  expect(host.textContent).toContain('Already claimed');expect(host.textContent).toContain('Расчёт выполняется');
  expect(createRunCancellationJournal(target,identity).read()).toBeNull();expect(button('Отменить до начала')).toBeUndefined();
});

test('viewer cannot send even a previously prepared cancellation',async()=>{
  queuedHistory();createRunCancellationJournal(target,identity).prepare('11111111-1111-4111-8111-111111111111',run.id);
  await mount({...project,role:'viewer'});expect(button('Отменить до начала')).toBeUndefined();
  expect(button('Проверить прежнюю отмену').disabled).toBe(true);expect(cancelQueuedStudyRun).not.toHaveBeenCalled();
});
test('launch is explicit, guarded from double click and bound to the saved version',async()=>{
  await mount();expect(createStudyRun).not.toHaveBeenCalled();
  await act(async()=>{button('Запустить версию 2').click();button('Запустить версию 2').click();});
  expect(createStudyRun).toHaveBeenCalledTimes(1);
  expect(createStudyRun).toHaveBeenCalledWith(target,expect.any(String),identity,expect.any(AbortSignal));
  expect(host.textContent).toContain('Результат сохранён');expect(button('Открыть результат')).toBeDefined();
  expect(createRunIntentJournal(target,identity).read()).toBeNull();
});
test('lost acknowledgement is restored after remount without automatic POST',async()=>{
  vi.mocked(createStudyRun).mockRejectedValueOnce(new Error('Lost response'));
  await mount();await act(async()=>button('Запустить версию 2').click());
  const command=createRunIntentJournal(target,identity).read()!.command;
  expect(host.textContent).toContain('Подтверждение запуска не получено');
  expect(button('Запустить версию 2').disabled).toBe(true);
  await act(async()=>root.unmount());root=createRoot(host);await mount();
  expect(createStudyRun).toHaveBeenCalledTimes(1);
  await act(async()=>button('Проверить прежнюю команду').click());
  expect(createStudyRun).toHaveBeenLastCalledWith(target,command,identity,expect.any(AbortSignal));
  expect(host.textContent).toContain('Результат сохранён');
});
test('server history restores runs with no local journal, including viewer access',async()=>{
  vi.mocked(listStudyRuns).mockResolvedValue({items:[run],next:''});
  await mount({...project,role:'viewer'});
  expect(button('Запустить версию 2')).toBeUndefined();expect(host.textContent).toContain('Результат сохранён');
  expect(createStudyRun).not.toHaveBeenCalled();expect(readStudyRun).toHaveBeenCalledWith(target,run.id,expect.any(AbortSignal));
});
test('network failure stops monitoring and explicitly resumes without another POST',async()=>{
  vi.mocked(listStudyRuns).mockResolvedValue({items:[{...run,status:'running',archiveId:undefined}],next:''});
  vi.mocked(readStudyRun).mockRejectedValueOnce(new Error('Offline'));
  await mount();expect(host.textContent).toContain('Состояние запуска не подтверждено');
  await act(async()=>button('Проверить состояние').click());
  expect(host.textContent).toContain('Результат сохранён');expect(createStudyRun).not.toHaveBeenCalled();
});
test('changing identity or version aborts old reads and does not restore another scope',async()=>{
  let resolve!:(v:{items:StudyRun[];next:string})=>void;
  vi.mocked(listStudyRuns).mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
  await mount();const oldSignal=vi.mocked(listStudyRuns).mock.calls[0][1];
  await mount({...project,id:'9'},{...version,projectId:'9'}, {...identity,sessionId:'5'});
  expect(oldSignal.aborted).toBe(true);
  await act(async()=>resolve({items:[run],next:''}));
  expect(host.textContent).not.toContain(`Запуск №${run.id}`);
});
test('revoked access clears private history and prevents a late monitor from displaying it',async()=>{
  vi.mocked(listStudyRuns).mockRejectedValue(new SessionError(404,'Unavailable'));
  await mount();expect(unavailable).toHaveBeenCalledTimes(1);expect(host.textContent).not.toContain(`Запуск №${run.id}`);
});

test('denied refresh fences an already running monitor even before the parent unmounts',async()=>{
  let finish!:(value:StudyRun)=>void;
  vi.mocked(listStudyRuns).mockResolvedValueOnce({items:[run],next:''}).mockRejectedValueOnce(new SessionError(404,'Unavailable'));
  vi.mocked(readStudyRun).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await mount();
  const signal=vi.mocked(readStudyRun).mock.calls[0][2];
  await act(async()=>button('Обновить историю запусков').click());
  expect(unavailable).toHaveBeenCalledTimes(1);
  await act(async()=>finish(run));
  expect(host.textContent).not.toContain(`Запуск №${run.id}`);
  expect(signal.aborted).toBe(true);
  expect(button('Запустить версию 2')).toBeUndefined();
});

test('denied history aborts archive loading and a late archive never reopens private data',async()=>{
  vi.mocked(listStudyRuns).mockResolvedValue({items:[run],next:''});
  let finish!:(value:OpenCalculationArchive)=>void;
  vi.mocked(readCalculationArchive).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await mount();
  await act(async()=>button('Открыть результат').click());
  const signal=vi.mocked(readCalculationArchive).mock.calls[0][2];
  vi.mocked(listStudyRuns).mockRejectedValueOnce(new SessionError(403,'Unavailable'));
  await act(async()=>button('Обновить историю запусков').click());
  const archive:OpenCalculationArchive={metadata:{id:'4',schemeId:version.schemeId,schemeName:version.schemeName,authorAccountId:'1',topologyRevision:version.topologyRevision,modelGroup:'three-phase',method:'newton-raphson',createdAt:version.createdAt,inputSha256:version.inputSha256,provenanceSha256:version.provenanceSha256,resultSha256:'c'.repeat(64),inputBytes:1,resultBytes:1},input:{modelGroup:'three-phase',method:'newton-raphson',components:[],connections:[]},result:{success:true,nodes:[],node_count:0,iterations:0,computation_time_ms:0,method_used:'newton-raphson'}};
  await act(async()=>finish(archive));
  expect(signal.aborted).toBe(true);expect(unavailable).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role=dialog]')).toBeNull();
  expect(host.textContent).toContain('Доступ к запускам завершён');
});

test('late launch acknowledgement after denial preserves its journal for explicit recovery',async()=>{
  let finish!:(value:StudyRun)=>void;
  vi.mocked(createStudyRun).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await mount();await act(async()=>button('Запустить версию 2').click());
  const signal=vi.mocked(createStudyRun).mock.calls[0][3];
  const command=createRunIntentJournal(target,identity).read()!.command;
  vi.mocked(listStudyRuns).mockRejectedValueOnce(new SessionError(401,'Unavailable'));
  await act(async()=>button('Обновить историю запусков').click());
  await act(async()=>finish(run));
  expect(signal.aborted).toBe(true);expect(unavailable).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain(`Запуск №${run.id}`);
  expect(createRunIntentJournal(target,identity).read()!.command).toBe(command);
  expect(createStudyRun).toHaveBeenCalledTimes(1);
});
test('a different live cookie identity invalidates the old UI context',async()=>{
  vi.mocked(createStudyRun).mockRejectedValue(new RunRequestError(409,'Session changed','run_session_changed'));
  await mount();await act(async()=>button('Запустить версию 2').click());
  expect(unavailable).toHaveBeenCalledTimes(1);
});
test('a mismatched project cannot read another Study history',async()=>{
  await mount({...project,id:'9'});
  expect(listStudyRuns).not.toHaveBeenCalled();expect(host.textContent).toContain('не относится к выбранному проекту');
});
