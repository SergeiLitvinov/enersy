import { SessionError, type Identity } from './projects-api';
import type { StudyVersion } from './studies-api';

export type RunStatus = 'queued' | 'validating' | 'initializing' | 'running' | 'succeeded' | 'failed';
export type RunErrorCode = 'worker_unavailable' | 'worker_transport' | 'worker_rejected' | 'invalid_result' | 'archive_quota' | 'lease_exhausted' | 'invalid_snapshot';
export interface StudyRun {
  id: string; projectId: string; studyId: string; studyRevision: string; requestedBy: string;
  status: RunStatus; inputSha256: string; provenanceSha256: string; createdAt: string;
  archiveId?: string; errorCode?: RunErrorCode;
}
export type RunTarget = Pick<StudyVersion, 'projectId' | 'id' | 'revision' | 'inputSha256' | 'provenanceSha256'>;
export class RunRequestError extends SessionError {
  constructor(status: number, message: string, public code: string) { super(status, message); }
}
const fail = (): never => { throw new Error('Некорректный ответ или привязка запуска Study'); };
export function runID(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value)>9223372036854775807n || String(BigInt(value))!==value) return fail();
  return value;
}
export function runSHA(value: unknown): string {
  if (typeof value!=='string' || value.length!==64 || !/^[0-9a-f]{64}$/.test(value)) return fail();
  return value;
}
export function runCommand(value: unknown): string {
  if (typeof value!=='string' || value.length!==36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return fail();
  return value;
}
const record=(value: unknown): Record<string,unknown> => {
  if (!value || typeof value!=='object' || Array.isArray(value)) return fail();
  return value as Record<string,unknown>;
};
const errors: RunErrorCode[]=['worker_unavailable','worker_transport','worker_rejected','invalid_result','archive_quota','lease_exhausted','invalid_snapshot'];
export const isActiveRun=(run: StudyRun) => !['succeeded','failed'].includes(run.status);
export function parseStudyRun(value: unknown, target: RunTarget): StudyRun {
  const v=record(value);
  const keys=['id','projectId','studyId','studyRevision','requestedBy','status','inputSha256','provenanceSha256','createdAt'];
  const terminal=v.status==='succeeded' ? ['archiveId'] : v.status==='failed' ? ['errorCode'] : [];
  if (Object.keys(v).length!==keys.length+terminal.length || ![...keys,...terminal].every(k=>Object.prototype.hasOwnProperty.call(v,k)) ||
    v.projectId!==runID(target.projectId) || v.studyId!==runID(target.id) || v.studyRevision!==runID(target.revision) ||
    v.inputSha256!==runSHA(target.inputSha256) || v.provenanceSha256!==runSHA(target.provenanceSha256) ||
    !['queued','validating','initializing','running','succeeded','failed'].includes(String(v.status)) ||
    typeof v.createdAt!=='string' || v.createdAt.trim()!==v.createdAt || !/^\d{4}-\d\d-\d\dT/.test(v.createdAt) || !Number.isFinite(Date.parse(v.createdAt))) return fail();
  runID(v.id);runID(v.requestedBy);
  if (v.status==='succeeded') runID(v.archiveId);
  if (v.status==='failed' && !errors.includes(v.errorCode as RunErrorCode)) return fail();
  return {...v} as unknown as StudyRun;
}
const collection=(target: RunTarget) => `/api/projects/${runID(target.projectId)}/studies/${runID(target.id)}/versions/${runID(target.revision)}/runs`;
async function request(url: string,signal: AbortSignal,headers?: Record<string,string>): Promise<Response> {
  signal.throwIfAborted();
  const response=await fetch(url,{method:headers?'POST':'GET',headers,signal,credentials:'same-origin',cache:'no-store'});
  signal.throwIfAborted();
  if (!response.ok) {
    let detail: Record<string,unknown>={};
    try { detail=record(await response.json()); } catch { /* Safe fallback; an untrusted response cannot grant success. */ }
    signal.throwIfAborted();
    throw new RunRequestError(response.status,typeof detail.error==='string'?detail.error:'Запуск недоступен',typeof detail.code==='string'?detail.code:'run_request_failed');
  }
  return response;
}
async function envelope(response: Response,target: RunTarget,signal: AbortSignal): Promise<StudyRun> {
  const v=record(await response.json());signal.throwIfAborted();
  if (Object.keys(v).length!==3 || v.formatVersion!==1) return fail();
  const run=parseStudyRun(v.run,target);
  if (v.runId!==run.id) return fail();
  return run;
}
export async function createStudyRun(target: RunTarget,command: string,identity: Pick<Identity,'accountId'|'sessionId'>,signal: AbortSignal): Promise<StudyRun> {
  const response=await request(collection(target),signal,{'Idempotency-Key':runCommand(command),'X-Enersy-Account-Id':runID(identity.accountId),'X-Enersy-Session-Id':runID(identity.sessionId)});
  if (response.status!==202) return fail();
  const run=await envelope(response,target,signal);
  if (response.headers.get('Location')!==`/api/projects/${target.projectId}/runs/${run.id}`) return fail();
  return run;
}
export async function readStudyRun(target: RunTarget,id: string,signal: AbortSignal): Promise<StudyRun> {
  const response=await request(`/api/projects/${runID(target.projectId)}/runs/${runID(id)}`,signal);
  if (response.status!==200) return fail();
  const run=await envelope(response,target,signal);
  if (run.id!==id) return fail();
  return run;
}
export async function listStudyRuns(target: RunTarget,signal: AbortSignal,before=''): Promise<{items: StudyRun[]; next: string}> {
  const response=await request(`${collection(target)}${before?`?beforeId=${runID(before)}`:''}`,signal);
  if (response.status!==200) return fail();
  const v=record(await response.json());signal.throwIfAborted();
  if (v.formatVersion!==1 || !Array.isArray(v.items) || v.items.length>25 || Object.keys(v).some(k=>!['formatVersion','items','nextBeforeId'].includes(k))) return fail();
  const items=v.items.map(item=>parseStudyRun(item,target));
  let previous=before?BigInt(before):9223372036854775808n;
  for (const item of items) { if (BigInt(item.id)>=previous) return fail();previous=BigInt(item.id); }
  const next=v.nextBeforeId===undefined?'':runID(v.nextBeforeId);
  if (next && (items.length!==25 || next!==items[items.length-1]?.id)) return fail();
  return {items,next};
}
