/** Narrow interface of the Node-only HTTP acceptance helper. */
export interface HttpSessionContext {
  getStore(): number | undefined;
  run<T>(session: number, action: () => T): T;
  disable(): void;
}
export function createHttpSessionContext(): HttpSessionContext;
