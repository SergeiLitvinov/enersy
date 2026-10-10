import type * as api from '../../api/ees-api';

/** One immutable transport per mounted editor context. Catalog reads may remain
 * shared; graph reads, writes, recovery and calculations must share one scope.
 * Mount a new keyed editor when changing the account/project transport.
 */
export type SchemeTransport = Pick<typeof api,
  'getComponentTypes' | 'getComponentParams' | 'getSchemes' | 'getScheme' |
  'createScheme' | 'deleteScheme' | 'addComponent' | 'deleteComponent' |
  'updateComponent' | 'patchComponent' | 'setComponentParam' |
  'newConnectionCommandId' | 'addConnection' | 'deleteConnection' | 'calculateScheme'>;
