// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {StudyRunPanel} from './StudyRunPanel';
import {createStudyRun,listStudyRuns,readStudyRun,RunRequestError,type StudyRun} from '../../api/study-runs-api';
import {createRunIntentJournal} from './run-intent-journal';
import {SessionError,type Project} from '../../api/projects-api';
import type {StudyVersion} from '../../api/studies-api';
vi.mock('../../api/study-runs-api',async original=>({...await original<typeof import('../../api/study-runs-api')>(),createStudyRun:vi.fn(),listStudyRuns:vi.fn(),readStudyRun:vi.fn()}));
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
test('a different live cookie identity invalidates the old UI context',async()=>{
  vi.mocked(createStudyRun).mockRejectedValue(new RunRequestError(409,'Session changed','run_session_changed'));
  await mount();await act(async()=>button('Запустить версию 2').click());
  expect(unavailable).toHaveBeenCalledTimes(1);
});
test('a mismatched project cannot read another Study history',async()=>{
  await mount({...project,id:'9'});
  expect(listStudyRuns).not.toHaveBeenCalled();expect(host.textContent).toContain('не относится к выбранному проекту');
});
