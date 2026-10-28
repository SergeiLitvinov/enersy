// @vitest-environment jsdom
import {beforeEach,expect,test} from 'vitest';
import {createRunIntentJournal,forgetOtherRunSessions} from './run-intent-journal';
const target={projectId:'8',id:'9007199254740993',revision:'2',inputSha256:'a'.repeat(64),provenanceSha256:'b'.repeat(64)};
const identity={accountId:'1',sessionId:'2'};
const command='11111111-1111-4111-8111-111111111111';
beforeEach(()=>sessionStorage.clear());
test('an uncertain command survives reload without replacement',()=>{
  createRunIntentJournal(target,identity).prepare(command);
  const recovered=createRunIntentJournal(target,identity);
  expect(recovered.read()?.command).toBe(command);
  expect(()=>recovered.prepare('22222222-2222-4222-8222-222222222222')).toThrow();
  expect(()=>recovered.clear('22222222-2222-4222-8222-222222222222')).toThrow();
  expect(recovered.prepare(command).command).toBe(command);
  recovered.clear(command);expect(recovered.read()).toBeNull();
});
test('account, session, project and version remain separate',()=>{
  createRunIntentJournal(target,identity).prepare(command);
  for(const [v,i] of [[{...target,projectId:'9'},identity],[{...target,id:'2'},identity],[{...target,revision:'3'},identity],[target,{...identity,accountId:'3'}],[target,{...identity,sessionId:'4'}]] as const)expect(createRunIntentJournal(v,i).read()).toBeNull();
  expect(()=>createRunIntentJournal({...target,inputSha256:'c'.repeat(64)},identity).read()).toThrow();
});
test('logout and observed identity switch remove only this feature journals',()=>{
  createRunIntentJournal(target,identity).prepare(command);
  createRunIntentJournal(target,{accountId:'1',sessionId:'3'}).prepare(command);
  sessionStorage.setItem('unrelated','keep');
  forgetOtherRunSessions(identity);
  expect(createRunIntentJournal(target,identity).read()?.command).toBe(command);
  expect(createRunIntentJournal(target,{accountId:'1',sessionId:'3'}).read()).toBeNull();
  forgetOtherRunSessions(null);expect(createRunIntentJournal(target,identity).read()).toBeNull();expect(sessionStorage.getItem('unrelated')).toBe('keep');
});
test('storage failure prevents admission and corrupted data is not silently replaced',()=>{
  expect(()=>createRunIntentJournal(target,identity,()=>{throw new Error('unavailable');}).prepare(command)).toThrow();
  createRunIntentJournal(target,identity).prepare(command);
  const key=sessionStorage.key(0)!;sessionStorage.setItem(key,'{}');
  const journal=createRunIntentJournal(target,identity);
  expect(()=>journal.read()).toThrow();expect(()=>journal.prepare(command)).toThrow();expect(sessionStorage.getItem(key)).toBe('{}');
});
