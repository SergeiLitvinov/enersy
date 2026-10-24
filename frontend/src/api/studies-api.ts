import { SessionError } from './projects-api';
import { isComputeBackendId, type ComputeBackendId } from './compute-backends';
import { isCalculationBudget } from './calculation-execution';
import { parseTerminalVoltageLimits, type TerminalVoltageLimit } from './operating-assessment';
export interface StudyDocument {
    formatVersion: 1;
    name: string;
    modelGroup: 'three-phase';
    method: 'newton-raphson';
    computeBackend: ComputeBackendId;
    maxTimeMs: number;
    base: {
        s_base_mva: number;
        v_base_kv: number;
    };
    solverOptions: {
        tolerance: number;
        max_iterations: number;
    };
    operatingLimits: TerminalVoltageLimit[];
}
export interface StudyVersion {
    status: 'captured';
    id: string;
    projectId: string;
    schemeId: string;
    revision: string;
    authorAccountId: string;
    topologyRevision: string;
    schemeName: string;
    createdAt: string;
    inputSha256: string;
    provenanceSha256: string;
    inputBytes: number;
    provenanceBytes: number;
    document: StudyDocument;
}
export class StudyWriteError extends SessionError {
    constructor(status: number, message: string, public code: string) { super(status, message); }
}
const fail = (): never => { throw new Error('Некорректное исследование или снимок Study'); };
const row = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v))
    return fail(); return v as Record<string, unknown>; };
const id = (v: unknown): string => { if (typeof v !== 'string' || !(/^[1-9][0-9]{0,18}$/).test(v) || BigInt(v) > 9223372036854775807n)
    return fail(); return v; };
const revision = (v: unknown): string => v === '0' ? '0' : id(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(v, k));
const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const size = (v: unknown): v is number => positive(v) && Number.isInteger(v) && v <= 8388608;
/** Explicit units and options; no defaults are synthesized for an existing Study. */
export function parseStudyDocument(raw: unknown): StudyDocument {
    const v = row(raw), base = row(v.base), solver = row(v.solverOptions);
    if (!exact(v, ['formatVersion', 'name', 'modelGroup', 'method', 'computeBackend', 'maxTimeMs', 'base', 'solverOptions', 'operatingLimits']) ||
        v.formatVersion !== 1 || typeof v.name !== 'string' || !v.name.trim() || v.name.includes('\0') || Array.from(v.name).length > 200 ||
        v.modelGroup !== 'three-phase' || v.method !== 'newton-raphson' || !isComputeBackendId(v.computeBackend) || !isCalculationBudget(v.maxTimeMs) ||
        !exact(base, ['s_base_mva', 'v_base_kv']) || !positive(base.s_base_mva) || !positive(base.v_base_kv) || !exact(solver, ['tolerance', 'max_iterations']) ||
        !positive(solver.tolerance) || !positive(solver.max_iterations) || !Number.isInteger(solver.max_iterations) || solver.max_iterations > 1000)
        return fail();
    return { formatVersion: 1, name: v.name, modelGroup: v.modelGroup, method: v.method, computeBackend: v.computeBackend, maxTimeMs: v.maxTimeMs,
        base: { s_base_mva: base.s_base_mva, v_base_kv: base.v_base_kv }, solverOptions: { tolerance: solver.tolerance, max_iterations: solver.max_iterations }, operatingLimits: parseTerminalVoltageLimits(v.operatingLimits) };
}
export function parseStudyVersion(raw: unknown, project: string): StudyVersion {
    const v = row(raw);
    id(v.id);
    id(v.schemeId);
    id(v.revision);
    id(v.authorAccountId);
    revision(v.topologyRevision);
    if (v.projectId !== id(project) || v.status !== 'captured' || BigInt(v.schemeId as string) > 2147483647n || typeof v.schemeName !== 'string' ||
        typeof v.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(v.createdAt) || !Number.isFinite(Date.parse(v.createdAt)) ||
        !sha(v.inputSha256) || !sha(v.provenanceSha256) || !size(v.inputBytes) || !size(v.provenanceBytes))
        return fail();
    return { ...v, document: parseStudyDocument(v.document) } as unknown as StudyVersion;
}
const path = (project: string) => `/api/projects/${id(project)}/studies`;
async function request(url: string, signal: AbortSignal, body?: unknown, headers?: Record<string, string>): Promise<Response> {
    signal.throwIfAborted();
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal, credentials: 'same-origin', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }) });
    signal.throwIfAborted();
    if (!response.ok) {
        let detail: Record<string, unknown> = {};
        try {
            detail = row(await response.json());
        }
        catch { /* Keep a safe fallback for a malformed error response. */ }
        signal.throwIfAborted();
        throw new StudyWriteError(response.status, typeof detail.error === 'string' ? detail.error : 'Исследование недоступно или изменено другой сессией', typeof detail.code === 'string' ? detail.code : 'study_request_failed');
    }
    return response;
}
async function metadata(response: Response, project: string, signal: AbortSignal): Promise<StudyVersion> {
    const result = parseStudyVersion(await response.json(), project);
    signal.throwIfAborted();
    if (response.headers.get('ETag') !== `"${result.revision}"`)
        return fail();
    return result;
}
export async function readStudy(project: string, study: string, signal: AbortSignal, version?: string): Promise<StudyVersion> {
    const response = await request(`${path(project)}/${id(study)}${version === undefined ? '' : `/versions/${id(version)}`}`, signal);
    const result = await metadata(response, project, signal);
    if (result.id !== study || (version !== undefined && result.revision !== version))
        return fail();
    return result;
}
async function saveStudy(url: string, project: string, topology: string, document: StudyDocument, command: string, signal: AbortSignal, expected?: string): Promise<StudyVersion> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(command))
        return fail();
    const captured = parseStudyDocument(document);
    const response = await request(url, signal, { topologyRevision: revision(topology), document: captured }, { 'Idempotency-Key': command, ...(expected === undefined ? {} : { 'If-Match': `"${id(expected)}"` }) });
    const result = await metadata(response, project, signal);
    if (result.topologyRevision !== topology || JSON.stringify(result.document) !== JSON.stringify(captured))
        return fail();
    return result;
}
export async function createStudy(project: string, scheme: string, topology: string, document: StudyDocument, command: string, signal: AbortSignal): Promise<StudyVersion> {
    if (BigInt(id(scheme)) > 2147483647n)
        return fail();
    const result = await saveStudy(`/api/projects/${id(project)}/schemes/${scheme}/studies`, project, topology, document, command, signal);
    if (result.schemeId !== scheme || result.revision !== '1')
        return fail();
    return result;
}
export async function appendStudyVersion(project: string, study: string, expected: string, topology: string, document: StudyDocument, command: string, signal: AbortSignal): Promise<StudyVersion> {
    const result = await saveStudy(`${path(project)}/${id(study)}/versions`, project, topology, document, command, signal, expected);
    if (result.id !== study || BigInt(result.revision) !== BigInt(expected) + 1n)
        return fail();
    return result;
}
async function page(project: string, signal: AbortSignal, after: string, study?: string): Promise<{
    items: StudyVersion[];
    next: string;
}> {
    if (after)
        id(after);
    const key = study === undefined ? 'afterId' : 'afterRevision', nextKey = study === undefined ? 'nextAfterId' : 'nextAfterRevision';
    const response = await request(`${path(project)}${study === undefined ? '' : `/${id(study)}/versions`}?limit=20${after ? `&${key}=${after}` : ''}`, signal);
    const data = row(await response.json());
    signal.throwIfAborted();
    if (!Array.isArray(data.items) || data.items.length > 20)
        return fail();
    const items = data.items.map(v => parseStudyVersion(v, project));
    let previous = after ? BigInt(after) : 0n;
    for (const item of items) {
        if (study !== undefined && item.id !== study)
            return fail();
        const value = BigInt(study === undefined ? item.id : item.revision);
        if (value <= previous)
            return fail();
        previous = value;
    }
    const next = data[nextKey] === undefined ? '' : id(data[nextKey]);
    if (next && (!items.length || BigInt(next) !== previous))
        return fail();
    return { items, next };
}
export const listStudies = (project: string, signal: AbortSignal, after = '') => page(project, signal, after);
export const listStudyVersions = (project: string, study: string, signal: AbortSignal, after = '') => page(project, signal, after, study);
/** Exact bounded artifact bytes. The caller may parse them off the UI thread.
 * An artifact is tied to a fixed version, never an implicit latest network. */
export async function readStudyArtifact(project: string, study: string, version: string, kind: 'input' | 'provenance', signal: AbortSignal): Promise<Uint8Array> {
    const meta = await readStudy(project, study, signal, version);
    const response = await request(`${path(project)}/${study}/versions/${version}/${kind}`, signal);
    const digest = kind === 'input' ? meta.inputSha256 : meta.provenanceSha256, length = kind === 'input' ? meta.inputBytes : meta.provenanceBytes;
    if (!response.body || response.headers.get('ETag') !== `"${digest}"` || response.headers.get('X-Enersy-Study-Id') !== study || response.headers.get('X-Enersy-Study-Revision') !== version)
        return fail();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            if (part.done)
                break;
            bytes += part.value.byteLength;
            if (bytes > length)
                return fail();
            chunks.push(part.value);
        }
    }
    finally {
        await reader.cancel();
        reader.releaseLock();
    }
    signal.throwIfAborted();
    if (bytes !== length)
        return fail();
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
    }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', content))].map(v => v.toString(16).padStart(2, '0')).join('');
    signal.throwIfAborted();
    if (hash !== digest)
        return fail();
    return content;
}
