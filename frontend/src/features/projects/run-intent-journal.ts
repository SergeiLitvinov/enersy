import { runCommand, runID, runSHA, type RunTarget } from '../../api/study-runs-api';
import type { Identity } from '../../api/projects-api';

const prefix='enersy.study-run.v1:';
type Scope=Pick<Identity,'accountId'|'sessionId'>;
export interface RunIntent { formatVersion: 1; command: string; inputSha256: string; provenanceSha256: string }
const fail=():never=>{ throw new Error('Локальная команда запуска недоступна или повреждена. Проверьте историю запусков перед новой командой.'); };
export function createRunIntentJournal(target: RunTarget,identity: Scope,storage:()=>Storage=()=>window.sessionStorage) {
  const key=`${prefix}${runID(identity.accountId)}:${runID(identity.sessionId)}:${runID(target.projectId)}:${runID(target.id)}:${runID(target.revision)}`;
  const input=runSHA(target.inputSha256),provenance=runSHA(target.provenanceSha256);
  const parse=(raw: string):RunIntent=>{
    if (raw.length>4096) return fail();
    const value:unknown=JSON.parse(raw);
    if (!value || typeof value!=='object' || Array.isArray(value)) return fail();
    const v=value as Record<string,unknown>;
    if (Object.keys(v).length!==4 || v.formatVersion!==1 || v.inputSha256!==input || v.provenanceSha256!==provenance) return fail();
    return {formatVersion:1,command:runCommand(v.command),inputSha256:input,provenanceSha256:provenance};
  };
  const read=():RunIntent|null=>{const raw=storage().getItem(key);return raw===null?null:parse(raw);};
  return {read,prepare(command:string):RunIntent {
    const intent:RunIntent={formatVersion:1,command:runCommand(command),inputSha256:input,provenanceSha256:provenance};
    const previous=read();
    if (previous && previous.command!==intent.command) throw new Error('Сначала проверьте исход прежней команды запуска.');
    const store=storage();let count=0;
    for(let i=0;i<store.length;i++) if(store.key(i)?.startsWith(prefix)) count++;
    if(!previous && count>=32) throw new Error('Достигнут предел локальных команд запуска. Проверьте прежние команды.');
    const body=JSON.stringify(intent);store.setItem(key,body);if(store.getItem(key)!==body) return fail();
    return intent;
  },clear(command:string){const previous=read();if(previous && previous.command!==command) return fail();storage().removeItem(key);if(storage().getItem(key)!==null) return fail();},
  discard(){storage().removeItem(key);if(storage().getItem(key)!==null) return fail();}};
}
export function forgetOtherRunSessions(identity:Scope|null,storage:()=>Storage=()=>window.sessionStorage){
  const keep=identity?`${prefix}${identity.accountId}:${identity.sessionId}:`:'';
  try {
    const store=storage(),keys:string[]=[];
    for(let i=0;i<store.length;i++){const k=store.key(i);if(k?.startsWith(prefix)&&(!keep||!k.startsWith(keep))) keys.push(k);}
    keys.forEach(k=>store.removeItem(k));
  } catch { /* Scoped keys still prevent another identity from reading an inaccessible journal. */ }
}
