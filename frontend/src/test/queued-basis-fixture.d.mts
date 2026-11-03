/** Narrow Node-only fixture reader; no filesystem capability enters application code. */
export function readQueuedBasisFixture(): Promise<{ login: string; password: string }>;
