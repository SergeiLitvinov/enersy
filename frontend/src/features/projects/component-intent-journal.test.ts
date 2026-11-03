// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { createComponentIntentJournal, forgetOtherComponentSessions } from './component-intent-journal';
import { captureEditorComponents, restoreProjectEditorJournal } from './editor-journal';
import { ComponentWrites } from '../../components/ees/component-writes';
import { compareComponentDraft } from '../../components/ees/component-comparison';
import type { ComponentWriteResult } from '../../api/component-revision';
import type { SchemeComponent } from '../../api/ees-api';
const scope={accountId:'1',sessionId:'2',projectId:'8',schemeId:'7'};
const base=(power=10)=>({profile:'ac-three-phase-rms-v1' as const,s_base_mva:power,v_base_kv:10});
const component=():SchemeComponent=>({id:101,typeId:1,type:'load',name:'',x:0,y:0,rotation:0,revision:'1',equipmentModelId:null,
  params:{p:'0.01000'},declaredParameterUnits:{formatVersion:2,units:{p:'p.u.'},bases:{p:base()}}});
const snapshot=(queue:ComponentWrites)=>({formatVersion:2 as const,components:captureEditorComponents(queue,'7'),graph:[]});
beforeEach(()=>sessionStorage.clear());

test('write-ahead basis intent survives reload and requires explicit comparison without a repeated write',async()=>{
 const journal=createComponentIntentJournal(scope), queue=new ComponentWrites(), source=component();queue.seed(7,source);
 queue.persistDraftsWith(()=>journal.save(snapshot(queue)),vi.fn());
 const action=vi.fn(async()=>{throw new Error('response lost');});
 const request=queue.run(source,()=>true,action,{schemeId:7,intent:{kind:'parameter',key:'p',value:'0.01000',unit:'p.u.',base:base(20)}});
 expect(journal.read().components[0]).toMatchObject({base:{params:{p:'0.01000'},declaredParameterUnits:{bases:{p:base()}}},
   intents:[{kind:'parameter',key:'p',value:'0.01000',unit:'p.u.',base:base(20)}]});
 expect(action).not.toHaveBeenCalled();await expect(request).rejects.toThrow('response lost');
 const reopened=createComponentIntentJournal(scope), restored=restoreProjectEditorJournal({...scope,name:'Network',writable:true,signal:new AbortController().signal},reopened.read());
 restored.queue.persistDraftsWith(()=>reopened.save(snapshot(restored.queue)),vi.fn());
 const server={...source,revision:'2',declaredParameterUnits:{...source.declaredParameterUnits!,bases:{p:base(20)}}};
 restored.queue.seed(7,server);const draft=restored.queue.drafts.failed(7)[0];
 expect(compareComponentDraft(draft,server)[0].status).toBe('already_applied');
 const noRepeat=vi.fn();await restored.queue.recover(draft,server,new Set(['parameter:p']),()=>true,noRepeat);
 expect(noRepeat).not.toHaveBeenCalled();expect(reopened.read().components).toEqual([]);
});

test('storage failure before dispatch retains the local intent and blocks the server write',async()=>{
 const queue=new ComponentWrites(),source=component();queue.seed(7,source);
 let blocked=false;const notice=vi.fn();
 queue.persistDraftsWith(()=>{if(blocked)throw new Error('storage full');},notice);blocked=true;
 const action=vi.fn();await expect(queue.run(source,()=>true,action,{schemeId:7,intent:{kind:'parameter',key:'p',value:'0.02000'}})).rejects.toThrow('storage full');
 expect(action).not.toHaveBeenCalled();expect(queue.drafts.failed(7)[0].intents).toMatchObject([{value:'0.02000'}]);
 expect(()=>queue.assertConfirmed(7)).toThrow();expect(notice).toHaveBeenCalled();
});

test('failure to remove an acknowledged disk record reports storage trouble without repeating a committed write',async()=>{
 const queue=new ComponentWrites(),source=component(),journal=createComponentIntentJournal(scope),notice=vi.fn();queue.seed(7,source);
 let failCleanup=false;queue.persistDraftsWith(()=>{const next=snapshot(queue);if(failCleanup&&!next.components.length)throw new Error('cleanup unavailable');journal.save(next);},notice);
 const action=vi.fn(async()=>{failCleanup=true;return{success:true as const,revision:'2'};});
 await expect(queue.run(source,()=>true,action,{schemeId:7,intent:{kind:'parameter',key:'p',value:'0.02000'}})).resolves.toMatchObject({revision:'2'});
 expect(action).toHaveBeenCalledOnce();expect(notice).toHaveBeenCalled();expect(queue.drafts.snapshot(7)).toEqual([]);
 expect(journal.read().components[0].intents[0]).toMatchObject({value:'0.02000'});
});

test('acknowledging an earlier operation keeps a newer queued intention durable',async()=>{
 const queue=new ComponentWrites(),source=component(),journal=createComponentIntentJournal(scope);queue.seed(7,source);
 queue.persistDraftsWith(()=>journal.save(snapshot(queue)),vi.fn());
 let first!:()=>void,second!:()=>void;
 const a=queue.run(source,()=>true,()=>new Promise<ComponentWriteResult>(resolve=>{first=()=>resolve({success:true,revision:'2'});}),{schemeId:7,intent:{kind:'parameter',key:'p',value:'0.02000'}});
 const b=queue.run(source,()=>true,()=>new Promise<ComponentWriteResult>(resolve=>{second=()=>resolve({success:true,revision:'3'});}),{schemeId:7,intent:{kind:'parameter',key:'p',value:'0.03000'}});
 expect(journal.read().components[0].intents).toHaveLength(2);
 await vi.waitFor(()=>expect(first).toBeDefined());first();await a;
 await vi.waitFor(()=>expect(second).toBeDefined());
 expect(journal.read().components[0]).toMatchObject({base:{revision:'2',params:{p:'0.02000'}},intents:[{value:'0.03000'}]});
 second();await b;expect(journal.read().components).toEqual([]);
});

test('scope, deep copies, corruption and logout isolate private parameter evidence',async()=>{
 const queue=new ComponentWrites(),source=component(),journal=createComponentIntentJournal(scope);queue.seed(7,source);
 await expect(queue.run(source,()=>true,async()=>{throw new Error('lost');},{schemeId:7,intent:{kind:'parameter',key:'p',value:'0.02000'}})).rejects.toThrow();
 journal.save(snapshot(queue));const copy=journal.read();copy.components[0].base.declaredParameterUnits!.bases!.p!.s_base_mva=999;
 expect(journal.read().components[0].base.declaredParameterUnits!.bases!.p!.s_base_mva).toBe(10);
 for(const changed of [{accountId:'3'},{sessionId:'4'},{projectId:'9'},{schemeId:'6'}])expect(createComponentIntentJournal({...scope,...changed}).read().components).toEqual([]);
 const other=createComponentIntentJournal({...scope,sessionId:'4'});other.save(snapshot(queue));
 forgetOtherComponentSessions(scope);expect(journal.read().components).toHaveLength(1);expect(other.read().components).toEqual([]);
 const key=sessionStorage.key(0)!;const forged=JSON.parse(sessionStorage.getItem(key)!);forged.scope.projectId='9';sessionStorage.setItem(key,JSON.stringify(forged));
 expect(()=>journal.read()).toThrow();forgetOtherComponentSessions(null);expect(sessionStorage.length).toBe(0);
});

test('recovery cannot dispatch a reviewed patch if its durable journal becomes unavailable',async()=>{
 const queue=new ComponentWrites(),source=component(),journal=createComponentIntentJournal(scope);queue.seed(7,source);
 let blocked=false;queue.persistDraftsWith(()=>{if(blocked)throw new Error('storage full');journal.save(snapshot(queue));},vi.fn());
 await expect(queue.run(source,()=>true,async()=>{throw new Error('lost');},{schemeId:7,intent:{kind:'parameter',key:'p',value:'0.02000'}})).rejects.toThrow('lost');
 const draft=queue.drafts.failed(7)[0],apply=vi.fn();blocked=true;
 await expect(queue.recover(draft,source,new Set(['parameter:p']),()=>true,apply)).rejects.toThrow('storage full');
 expect(apply).not.toHaveBeenCalled();expect(journal.read().components[0].intents[0]).toMatchObject({value:'0.02000'});
});

test('the payload limit is 256 KiB even when the envelope would fit its separate 260 KiB bound',async()=>{
 const queue=new ComponentWrites(),source=component(),journal=createComponentIntentJournal(scope);queue.seed(7,source);
 await expect(queue.run(source,()=>true,async()=>{throw new Error('lost');},{schemeId:7,intent:{kind:'parameter',key:'p',value:'0.02000'}})).rejects.toThrow();
 const small=snapshot(queue);journal.save(small);const large=structuredClone(small);
 for(let i=0;i<16;i++)large.components[0].base.params[`extra_${i}`]='x'.repeat(16384);
 expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(256*1024);
 expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeLessThan(260*1024);
 expect(()=>journal.save(large)).toThrow('256 КиБ');expect(journal.read()).toEqual(small);
});
