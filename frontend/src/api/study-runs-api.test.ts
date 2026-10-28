import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {createStudyRun,listStudyRuns,parseStudyRun,readStudyRun,runCommand,runID,type StudyRun} from './study-runs-api';
const target={projectId:'8',id:'9007199254740993',revision:'9007199254740994',inputSha256:'a'.repeat(64),provenanceSha256:'b'.repeat(64)};
const run=():StudyRun=>({id:'9007199254740995',projectId:'8',studyId:target.id,studyRevision:target.revision,requestedBy:'9007199254740996',status:'queued',inputSha256:target.inputSha256,provenanceSha256:target.provenanceSha256,createdAt:'2026-10-28T00:00:00Z'});
const command='11111111-1111-4111-8111-111111111111';
const signal=()=>new AbortController().signal;
const reply=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers});
const envelope=(v=run())=>({formatVersion:1,runId:v.id,run:v});
const fetcher=vi.fn<typeof fetch>();
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});
afterEach(()=>vi.unstubAllGlobals());
test('create sends only explicit version, original UUID and expected identity; no mutable graph',async()=>{
  fetcher.mockResolvedValue(reply(envelope(),202,{Location:'/api/projects/8/runs/9007199254740995'}));
  expect(await createStudyRun(target,command,{accountId:'9007199254740996',sessionId:'9007199254740997'},signal())).toEqual(run());
  const [path,options]=fetcher.mock.calls[0];
  expect(path).toBe('/api/projects/8/studies/9007199254740993/versions/9007199254740994/runs');
  expect(options).toMatchObject({method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Idempotency-Key':command,'X-Enersy-Account-Id':'9007199254740996','X-Enersy-Session-Id':'9007199254740997'}});
  expect(options?.body).toBeUndefined();
});
test('an incomplete acknowledgement stays uncertain, even for an HTTP success',async()=>{
  fetcher.mockResolvedValue(reply(envelope(),202));
  await expect(createStudyRun(target,command,{accountId:'1',sessionId:'2'},signal())).rejects.toThrow();
  fetcher.mockResolvedValue(reply({...envelope(),runId:'2'},202,{Location:'/api/projects/8/runs/2'}));
  await expect(createStudyRun(target,command,{accountId:'1',sessionId:'2'},signal())).rejects.toThrow();
});
test('run and archive references must match the selected immutable Study',()=>{
  expect(parseStudyRun({...run(),status:'succeeded',archiveId:'9007199254740998'},target).archiveId).toBe('9007199254740998');
  for(const mutation of [{projectId:'9'},{studyId:'2'},{studyRevision:'1'},{inputSha256:'c'.repeat(64)},{provenanceSha256:'d'.repeat(64)},{id:Number('9007199254740995')},{archiveId:'1'},{status:'succeeded'},{status:'failed'},{status:'failed',errorCode:'arbitrary'},{requestedBy:'1\n'},{status:'running',errorCode:'worker_transport'}])expect(()=>parseStudyRun({...run(),...mutation},target)).toThrow();
});
test('read verifies the requested Run and failed-state contract',async()=>{
  const failed={...run(),status:'failed' as const,errorCode:'lease_exhausted' as const};
  fetcher.mockResolvedValue(reply(envelope(failed)));
  expect(await readStudyRun(target,failed.id,signal())).toEqual(failed);
  await expect(readStudyRun(target,'2',signal())).rejects.toThrow();
});
test('history validates descending pagination and source hashes',async()=>{
  const items=Array.from({length:25},(_,i)=>({...run(),id:String(9007199254741099n-BigInt(i))}));
  const next=items[24].id;
  fetcher.mockResolvedValue(reply({formatVersion:1,items,nextBeforeId:next}));
  expect((await listStudyRuns(target,signal())).next).toBe(next);
  for(const body of [{formatVersion:2,items:[]},{formatVersion:1,items:[run(),run()]},{formatVersion:1,items:[{...run(),studyRevision:'1'}]},{formatVersion:1,items,nextBeforeId:'1'}]){
    fetcher.mockResolvedValue(reply(body));await expect(listStudyRuns(target,signal())).rejects.toThrow();
  }
});
test('invalid IDs, UUIDs and aborted intents cannot dispatch',async()=>{
  for(const value of ['0','01','1\n','9223372036854775808'])expect(()=>runID(value)).toThrow();
  expect(()=>runCommand(command+'\n')).toThrow();
  await expect(createStudyRun(target,'bad',{accountId:'1',sessionId:'2'},signal())).rejects.toThrow();
  const controller=new AbortController();controller.abort();await expect(listStudyRuns(target,controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
