import { parseParameterUnitDeclaration, type ParameterUnitDeclaration } from './parameter-unit-declaration';

/** Recovery data only. Decoding neither validates current topology nor sends commands. */
export interface EditorDraftPose { x: number; y: number; rotation: number; name: string }
export interface EditorDraftBase extends EditorDraftPose {
  projectPassportVersionId?: string | null;
  id: string; typeId: string; type: string; equipmentModelId: string | null;
  revision: string; params: Record<string, string>;
  declaredParameterUnits?: ParameterUnitDeclaration;
}
export type EditorComponentIntent =
  | { kind: 'pose'; values: Partial<EditorDraftPose> }
  | { kind: 'parameter'; key: string; value: string; unit?: string }
  | { kind: 'delete' };
export type EditorGraphIntent =
  | ({ kind: 'create-component'; typeId: string; equipmentModelId: string | null; projectPassportVersionId?: string | null; params: Record<string, string> } & EditorDraftPose)
  | { kind: 'create-connection'; commandId: string; from: string; to: string; fromPort: string; toPort: string; expectedTopologyRevision: string }
  | { kind: 'delete-connection'; id: string; expectedTopologyRevision: string };
export interface EditorDraftPayload {
  formatVersion: 1;
  components: { componentId: string; base: EditorDraftBase; intents: EditorComponentIntent[]; reason: string }[];
  graph: { intent: EditorGraphIntent; reason: string }[];
}
export const EDITOR_DRAFT_MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = (): never => { throw new Error('Некорректный журнал редактора'); };
export function draftRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return value as Record<string, unknown>;
}
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  const item = draftRecord(value);
  if (required.some(key => !owns(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return item;
}
export function draftRevision(value: unknown, zero = false): string {
  if (zero && value === '0') return value;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) ||
      (value.length === 19 && value > '9223372036854775807')) return invalid();
  return value;
}
export function draftId(value: unknown, graph = true): string {
  const id = draftRevision(value);
  if (graph && BigInt(id) > 2147483647n) return invalid();
  return id;
}
export function draftUUID(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return invalid();
  return value;
}
function text(value: unknown, limit: number, nonblank = false): string {
  if (typeof value !== 'string' || value.includes('\0') || [...value].length > limit || (nonblank && !value.trim())) return invalid();
  // JSON.stringify would preserve unpaired surrogates as escapes rejected by PostgreSQL.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return invalid();
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return invalid();
    }
  }
  return value;
}
function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) return invalid();
  return value;
}
function rotation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) return invalid();
  return value;
}
function pose(item: Record<string, unknown>): EditorDraftPose {
  return { x: coordinate(item.x), y: coordinate(item.y), rotation: rotation(item.rotation), name: text(item.name, 100, true) };
}
function parameterValue(value: unknown): string {
  const result = text(value, 16384);
  if (encoder.encode(result).length > 16384) return invalid();
  return result;
}
function params(value: unknown): Record<string, string> {
  const entries = Object.entries(draftRecord(value));
  if (entries.length > 256) return invalid();
  // Define own data properties, including a legitimate parameter named __proto__.
  return Object.fromEntries(entries.map(([key, value]) => [text(key, 50, true), parameterValue(value)]));
}
function model(value: unknown): string | null { return value === null || value === undefined ? null : draftId(value); }
function passport(item: Record<string, unknown>): { projectPassportVersionId?: string } {
  if (item.projectPassportVersionId == null) return {};
  if (item.equipmentModelId != null) return invalid();
  return { projectPassportVersionId: draftId(item.projectPassportVersionId, false) };
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit || Array.from({ length: value.length }, (_, i) => i).some(i => !owns(value, String(i)))) return invalid();
  return value;
}
function componentIntent(value: unknown): EditorComponentIntent {
  const kind = draftRecord(value).kind;
  if (kind === 'delete') { fields(value, ['kind']); return { kind }; }
  if (kind === 'parameter') {
    const item = fields(value, ['kind', 'key', 'value'], ['unit']);
    const key = text(item.key, 50, true), parameter = parameterValue(item.value);
    const unit = owns(item, 'unit') ? { unit: text(item.unit, 64, true) } : {};
    if (unit.unit !== undefined) parseParameterUnitDeclaration({ formatVersion: 1, units: { [key]: unit.unit } }, { [key]: parameter });
    return { kind, key, value: parameter, ...unit };
  }
  if (kind === 'pose') {
    const item = fields(value, ['kind', 'values']);
    const values = fields(item.values, [], ['x', 'y', 'rotation', 'name']);
    if (!Object.keys(values).length) return invalid();
    return { kind, values: {
      ...(owns(values, 'x') ? { x: coordinate(values.x) } : {}),
      ...(owns(values, 'y') ? { y: coordinate(values.y) } : {}),
      ...(owns(values, 'rotation') ? { rotation: rotation(values.rotation) } : {}),
      ...(owns(values, 'name') ? { name: text(values.name, 100, true) } : {}),
    } };
  }
  return invalid();
}
function graphIntent(value: unknown): EditorGraphIntent {
  const kind = draftRecord(value).kind;
  if (kind === 'create-component') {
    const item = fields(value, ['kind', 'typeId', 'name', 'x', 'y', 'rotation', 'params'], ['equipmentModelId', 'projectPassportVersionId']);
    return { kind, typeId: draftId(item.typeId), ...pose(item), ...passport(item), equipmentModelId: model(item.equipmentModelId), params: params(item.params) };
  }
  if (kind === 'create-connection') {
    const item = fields(value, ['kind', 'commandId', 'from', 'to', 'fromPort', 'toPort', 'expectedTopologyRevision']);
    const fromPort = text(item.fromPort, 64), toPort = text(item.toPort, 64);
    if (!fromPort || !toPort) return invalid();
    return { kind, commandId: draftUUID(item.commandId), from: draftId(item.from), to: draftId(item.to), fromPort, toPort,
      expectedTopologyRevision: draftRevision(item.expectedTopologyRevision, true) };
  }
  if (kind === 'delete-connection') {
    const item = fields(value, ['kind', 'id', 'expectedTopologyRevision']);
    return { kind, id: draftId(item.id), expectedTopologyRevision: draftRevision(item.expectedTopologyRevision, true) };
  }
  return invalid();
}
/** Fresh deep copy, canonical string IDs, no implicit physical parameters or CAS. */
export function parseEditorDraftPayload(value: unknown): EditorDraftPayload {
  const item = fields(value, ['formatVersion', 'components', 'graph']);
  if (item.formatVersion !== 1) return invalid();
  const seen = new Set<string>(), commands = new Set<string>();
  const components = array(item.components, 128).map(value => {
    const entry = fields(value, ['componentId', 'base', 'intents', 'reason']);
    const componentId = draftId(entry.componentId);
    if (seen.has(componentId)) return invalid();
    seen.add(componentId);
    const base = fields(entry.base, ['id', 'typeId', 'type', 'revision', 'name', 'x', 'y', 'rotation', 'params'], ['equipmentModelId', 'projectPassportVersionId', 'declaredParameterUnits']);
    if (draftId(base.id) !== componentId) return invalid();
    const type = text(base.type, 50);
    if (!type) return invalid();
    const intents = array(entry.intents, 64).map(componentIntent);
    if (!intents.length) return invalid();
    const baseParams = params(base.params);
    const units = owns(base, 'declaredParameterUnits') ? { declaredParameterUnits: parseParameterUnitDeclaration(base.declaredParameterUnits, baseParams) } : {};
    if (units.declaredParameterUnits) Object.values(units.declaredParameterUnits.units).forEach(unit => text(unit, 64, true));
    return { componentId, base: { id: componentId, typeId: draftId(base.typeId), type, revision: draftRevision(base.revision),
      ...pose(base), ...passport(base), ...units, equipmentModelId: model(base.equipmentModelId), params: baseParams }, intents, reason: text(entry.reason, 1024) };
  });
  const graph = array(item.graph, 128).map(value => {
    const entry = fields(value, ['intent', 'reason']);
    const intent = graphIntent(entry.intent);
    if (intent.kind === 'create-connection') {
      if (commands.has(intent.commandId)) return invalid();
      commands.add(intent.commandId);
    }
    return { intent, reason: text(entry.reason, 1024) };
  });
  return { formatVersion: 1, components, graph };
}
/** Validate before dispatch. No truncation, dropped intents or revision coercion. */
export function encodeEditorDraftPayload(value: unknown): string {
  const json = JSON.stringify(parseEditorDraftPayload(value));
  if (encoder.encode(json).length > EDITOR_DRAFT_MAX_BYTES) throw new Error('Журнал превышает предел 256 КиБ');
  return json;
}

// Shared scalar/object rules for subsequent wire versions.
export { text as draftText, fields as draftFields };
