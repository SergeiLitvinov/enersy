// Node-only acceptance support. Never imported by the application entry point.
import { AsyncLocalStorage } from 'node:async_hooks';

export function createHttpSessionContext() {
  const storage = new AsyncLocalStorage();
  return {
    getStore: () => storage.getStore(),
    run: (session, action) => storage.run(session, action),
    disable: () => storage.disable(),
  };
}
