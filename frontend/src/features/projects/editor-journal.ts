import { graphEntriesV2, parseEditorDraftPayloadV2, parseStoredEditorDraftPayload, type EditorDraftPayloadV2 } from '../../api/editor-draft-phases';
import { ComponentWrites } from '../../components/ees/component-writes';
import { createProjectEditorTransport, type ProjectEditorTransportOptions } from './project-editor-transport';

function schemeId(value: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || BigInt(value) > 2147483647n) throw new Error('Некорректная схема журнала');
  return Number(value);
}
/** Include prepared and unprepared work, without waiting or manufacturing CAS. */
export function captureEditorJournal(writes: ComponentWrites, scheme: string): EditorDraftPayloadV2 {
  const sid = schemeId(scheme);
  return parseEditorDraftPayloadV2({ formatVersion: 2,
    components: writes.drafts.snapshot(sid).map(draft => ({ componentId: String(draft.componentId), reason: draft.reason,
      intents: draft.intents, base: { ...draft.base, id: String(draft.base.id), typeId: String(draft.base.typeId),
        equipmentModelId: draft.base.equipmentModelId == null ? null : String(draft.base.equipmentModelId) } })),
    graph: writes.graph.snapshotV2(sid),
  });
}
/** New queue + transport as one unit. Imported work is blocked for explicit
 * comparison; promises, review capabilities and optimistic UI state are not restored. */
export function restoreProjectEditorJournal(options: Omit<ProjectEditorTransportOptions, 'connectionAttempts'>, value: unknown) {
  options.signal.throwIfAborted();
  const sid = schemeId(options.schemeId), payload = parseStoredEditorDraftPayload(value);
  const queue = new ComponentWrites();
  queue.drafts.restore(sid, payload.components.map(draft => ({ schemeId: sid, componentId: Number(draft.componentId), reason: draft.reason,
    intents: draft.intents, base: { ...draft.base, id: Number(draft.base.id), typeId: Number(draft.base.typeId),
      equipmentModelId: draft.base.equipmentModelId === null ? null : Number(draft.base.equipmentModelId) } })));
  const entries = graphEntriesV2(payload);
  queue.graph.restore(sid, entries);
  const transport = createProjectEditorTransport({ ...options, connectionAttempts: entries.flatMap(entry => entry.phase === 'prepared' && entry.intent.kind === 'create-connection' ? [entry.intent] : []) });
  return { queue, transport };
}
