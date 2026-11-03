import type { Identity } from '../../api/projects-api';
import { parseComponentRevision } from '../../api/component-revision';
import { createPrivateFormJournal, exactFormRecord, forgetOtherPrivateFormSessions, type PrivateFormScope } from './private-form-journal';
import type { ParameterFormDraft, ParameterFormDraftStore, ParameterFormFields } from '../../components/ees/panels/parameter-form-draft-context';

function fields(raw: unknown): ParameterFormFields {
  const value = exactFormRecord(raw, ['key', 'value', 'unit', 'power', 'voltage']);
  for (const key of Object.keys(value)) if (typeof value[key] !== 'string' || value[key].length > (key === 'value' ? 16384 : 4096)) throw new Error('Некорректный ввод параметра');
  if (!(value.key as string).trim() || (value.key as string).length > 256 || /\p{Cc}/u.test(value.key as string)) throw new Error('Некорректный ключ параметра');
  return { key: value.key, value: value.value, unit: value.unit, power: value.power, voltage: value.voltage } as ParameterFormFields;
}
function parse(raw: unknown): ParameterFormDraft {
  const value = exactFormRecord(raw, ['sourceRevision', 'base', 'draft']);
  const base = fields(value.base), draft = fields(value.draft);
  if (base.key !== draft.key) throw new Error('Параметр формы не совпадает с исходным');
  return { sourceRevision: parseComponentRevision(value.sourceRevision), base, draft };
}
export function createParameterFormDraftJournal(scope: PrivateFormScope, signal: AbortSignal, storage: () => Storage = () => window.sessionStorage): ParameterFormDraftStore {
  return createPrivateFormJournal('parameter-form', scope, signal, parse, storage);
}
export function forgetOtherParameterFormSessions(identity: Pick<Identity, 'accountId' | 'sessionId'> | null, storage: () => Storage = () => window.sessionStorage) {
  forgetOtherPrivateFormSessions('parameter-form', identity, storage);
}
