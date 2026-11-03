import type { Identity } from '../../api/projects-api';
import { createPrivateFormJournal, exactFormRecord as exact, forgetOtherPrivateFormSessions } from './private-form-journal';
import { parseParameterUnitDeclaration } from '../../api/parameter-unit-declaration';
import { loadProfileKeys, type LoadProfileDraft } from '../../domain/load-profile';
import type { LoadFormDraft, LoadFormDraftStore } from '../../components/ees/panels/load-form-draft-context';

function strings(raw: unknown): LoadProfileDraft {
  const value = exact(raw, loadProfileKeys);
  for (const key of loadProfileKeys) if (typeof value[key] !== 'string' || value[key].length > 4096) throw new Error('Некорректный ввод формы нагрузки');
  return Object.fromEntries(loadProfileKeys.map(key => [key, value[key]])) as LoadProfileDraft;
}
function parse(raw: unknown): LoadFormDraft {
  const value = exact(raw, ['base', 'draft', 'declaration', 'policy']);
  if (value.policy !== 'saved' && value.policy !== 'canonical') throw new Error('Некорректный ввод формы нагрузки');
  const base = strings(value.base), draft = strings(value.draft);
  const declaration = value.declaration === null ? null : parseParameterUnitDeclaration(value.declaration, base);
  return { base, draft, declaration, policy: value.policy };
}

/** Tab-local raw text, including invalid/incomplete numbers. Never a command. */
export function createLoadFormDraftJournal(scope: Pick<Identity, 'accountId' | 'sessionId'> & { projectId: string; schemeId: string },
  signal: AbortSignal, storage: () => Storage = () => window.sessionStorage): LoadFormDraftStore {
  return createPrivateFormJournal('load-form', scope, signal, parse, storage);
}

export function forgetOtherLoadFormSessions(identity: Pick<Identity, 'accountId' | 'sessionId'> | null, storage: () => Storage = () => window.sessionStorage) {
  forgetOtherPrivateFormSessions('load-form', identity, storage);
}
