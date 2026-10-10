import type * as api from '../../api/ees-api';

/** One immutable transport per mounted editor context. Catalog reads may remain
 * shared; graph reads, writes, recovery and calculations must share one scope.
 * Mount a new keyed editor when changing the account/project transport.
 */
export type EditorScheme = Pick<api.Scheme, 'id' | 'name' | 'description' | 'components' | 'connections'>;
export type SchemeTransport = Pick<typeof api,
  'getComponentTypes' | 'getComponentParams' |
  'createScheme' | 'deleteScheme' | 'addComponent' | 'deleteComponent' |
  'updateComponent' | 'patchComponent' | 'setComponentParam' |
  'newConnectionCommandId' | 'addConnection' | 'deleteConnection' | 'calculateScheme'> & {
    getScheme: (id: number) => Promise<EditorScheme>;
    getSchemes: () => Promise<Pick<api.Scheme, 'id' | 'name'>[]>;
  };
