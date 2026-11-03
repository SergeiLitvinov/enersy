import { createContext } from 'react';
import type { LoadProfileDraft } from '../../../domain/load-profile';
import type { ParameterUnitDeclaration } from '../../../api/parameter-unit-declaration';
import type { LoadUnitPolicy } from '../../../api/load-profile-declaration';

export interface LoadFormDraft {
  base: LoadProfileDraft;
  draft: LoadProfileDraft;
  declaration: ParameterUnitDeclaration | null;
  policy: LoadUnitPolicy;
}
export interface LoadFormDraftStore {
  read(componentId: number): LoadFormDraft | null;
  save(componentId: number, value: LoadFormDraft | null): void;
}
/** Optional private editor facility. It carries no transport or authorization. */
export const LoadFormDraftContext = createContext<LoadFormDraftStore | null>(null);
