import { createContext } from 'react';

export interface ParameterFormFields { key: string; value: string; unit: string; power: string; voltage: string }
export interface ParameterFormDraft { sourceRevision: string; base: ParameterFormFields; draft: ParameterFormFields }
export interface ParameterFormDraftStore {
  read(componentId: number): ParameterFormDraft | null;
  save(componentId: number, value: ParameterFormDraft | null): void;
}
export const ParameterFormDraftContext = createContext<ParameterFormDraftStore | null>(null);
