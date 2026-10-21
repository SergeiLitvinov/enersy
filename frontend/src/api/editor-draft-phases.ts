import { draftFields, draftId, draftRecord, draftText, draftUUID, EDITOR_DRAFT_MAX_BYTES, parseEditorDraftPayload,
  type EditorDraftPayload, type EditorGraphIntent } from './editor-draft-payload';

export type UnpreparedGraphIntent =
  | Extract<EditorGraphIntent, { kind: 'create-component' }>
  | Omit<Extract<EditorGraphIntent, { kind: 'create-connection' }>, 'expectedTopologyRevision'>
  | Omit<Extract<EditorGraphIntent, { kind: 'delete-connection' }>, 'expectedTopologyRevision'>;
export type EditorGraphEntryV2 =
  | { phase: 'prepared'; intent: EditorGraphIntent; reason: string }
  | { phase: 'unprepared'; intent: UnpreparedGraphIntent; reason: string };
export interface EditorDraftPayloadV2 {
  formatVersion: 2;
  components: EditorDraftPayload['components'];
  graph: EditorGraphEntryV2[];
}
export type StoredEditorDraftPayload = EditorDraftPayload | EditorDraftPayloadV2;

function prepared(value: unknown): EditorGraphIntent {
  return parseEditorDraftPayload({ formatVersion: 1, components: [], graph: [{ intent: value, reason: '' }] }).graph[0].intent;
}
function unprepared(value: unknown): UnpreparedGraphIntent {
  const kind = draftRecord(value).kind;
  if (kind === 'create-component') {
    const result = prepared(value);
    if (result.kind !== 'create-component') throw new Error('Некорректное намерение оборудования');
    return result;
  }
  if (kind === 'delete-connection') {
    const item = draftFields(value, ['kind', 'id']);
    return { kind, id: draftId(item.id) };
  }
  if (kind === 'create-connection') {
    const item = draftFields(value, ['kind', 'commandId', 'from', 'to', 'fromPort', 'toPort']);
    const fromPort = draftText(item.fromPort, 64), toPort = draftText(item.toPort, 64);
    if (!fromPort || !toPort) throw new Error('Не указаны порты намерения');
    return { kind, commandId: draftUUID(item.commandId), from: draftId(item.from), to: draftId(item.to), fromPort, toPort };
  }
  throw new Error('Неизвестное структурное намерение');
}
/** Absence of preparation evidence is not proof that a mutation never ran. */
export function parseEditorDraftPayloadV2(value: unknown): EditorDraftPayloadV2 {
  const item = draftFields(value, ['formatVersion', 'components', 'graph']);
  if (item.formatVersion !== 2 || !Array.isArray(item.graph) || item.graph.length > 128 ||
      Array.from({ length: item.graph.length }, (_, i) => i).some(i => !Object.prototype.hasOwnProperty.call(item.graph, i))) {
    throw new Error('Некорректная версия или список намерений журнала');
  }
  const components = parseEditorDraftPayload({ formatVersion: 1, components: item.components, graph: [] }).components;
  const commands = new Set<string>();
  const graph = item.graph.map((value): EditorGraphEntryV2 => {
    const entry = draftFields(value, ['phase', 'intent', 'reason']);
    const reason = draftText(entry.reason, 1024);
    let result: EditorGraphEntryV2;
    if (entry.phase === 'prepared') result = { phase: 'prepared', intent: prepared(entry.intent), reason };
    else if (entry.phase === 'unprepared') result = { phase: 'unprepared', intent: unprepared(entry.intent), reason };
    else throw new Error('Неизвестная фаза намерения');
    if (result.intent.kind === 'create-connection') {
      if (commands.has(result.intent.commandId)) throw new Error('Повторный UUID в журнале');
      commands.add(result.intent.commandId);
    }
    return result;
  });
  return { formatVersion: 2, components, graph };
}
export function parseStoredEditorDraftPayload(value: unknown): StoredEditorDraftPayload {
  return draftRecord(value).formatVersion === 2 ? parseEditorDraftPayloadV2(value) : parseEditorDraftPayload(value);
}
export function encodeStoredEditorDraftPayload(value: unknown): string {
  const json = JSON.stringify(parseStoredEditorDraftPayload(value));
  if (new TextEncoder().encode(json).length > EDITOR_DRAFT_MAX_BYTES) throw new Error('Журнал превышает предел 256 КиБ');
  return json;
}
/** V1 contains only fully prepared graph commands. Never manufacture missing CAS. */
export function graphEntriesV2(payload: StoredEditorDraftPayload): EditorGraphEntryV2[] {
  return payload.formatVersion === 1 ? payload.graph.map(entry => ({ ...entry, phase: 'prepared' })) : payload.graph;
}
