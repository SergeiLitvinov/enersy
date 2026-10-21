import type * as api from '../../api/ees-api';
import type { EditorGraphIntent } from '../../api/editor-draft-payload';
import type { listProjectPassports } from '../../api/project-passports-api';

export type GraphDispatchCapture = (intent: EditorGraphIntent) => void | Promise<void>;

/** One immutable transport per mounted editor context. Catalog reads may remain
 * shared; graph reads, writes, recovery and calculations must share one scope.
 * Mount a new keyed editor when changing the account/project transport.
 */
export type EditorScheme = Pick<api.Scheme, 'id' | 'name' | 'description' | 'components' | 'connections'>;
export type SchemeTransport = Pick<typeof api,
  'getComponentTypes' | 'getComponentParams' |
  'createScheme' | 'deleteScheme' | 'deleteComponent' |
  'updateComponent' | 'patchComponent' | 'setComponentParam' |
  'newConnectionCommandId' | 'calculateScheme'> & {
    // Optional observation of the exact private command immediately before dispatch.
    // Legacy functions remain assignable but do not provide persistent CAS evidence.
    projectPassports?: (signal: AbortSignal, after?: string) => ReturnType<typeof listProjectPassports>;
    addComponent: (...args: [...Parameters<typeof api.addComponent>, capture?: GraphDispatchCapture, projectPassportVersionId?: string | null]) => ReturnType<typeof api.addComponent>;
    addConnection: (...args: [...Parameters<typeof api.addConnection>, capture?: GraphDispatchCapture]) => ReturnType<typeof api.addConnection>;
    deleteConnection: (id: number, capture?: GraphDispatchCapture) => ReturnType<typeof api.deleteConnection>;
    getScheme: (id: number) => Promise<EditorScheme>;
    getSchemes: () => Promise<Pick<api.Scheme, 'id' | 'name'>[]>;
  };
