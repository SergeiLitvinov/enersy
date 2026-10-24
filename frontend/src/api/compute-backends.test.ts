import { afterEach, expect, test, vi } from 'vitest';
import { getComputeBackends, parseCalculationBackend, requireSelectedBackend } from './compute-backends';
const julia = { id: 'julia', version: '0.1.0', julia_version: '1.10.12', jacobian: 'julia', linear_solver: 'umfpack' };
const native = { ...julia, id: 'julia-rust-jacobian', version: 'c-abi-v1', jacobian: 'rust', julia_core_version: '0.1.0',
  library_sha256: 'a'.repeat(64), julia_core_sha256: 'b'.repeat(64), adapter_sha256: 'c'.repeat(64) };
afterEach(() => vi.unstubAllGlobals());
test('legacy results remain unknown; native metadata is complete and consistent', () => {
  expect(parseCalculationBackend(undefined)).toBeUndefined();
  expect(parseCalculationBackend({ equations: 4 })).toBeUndefined();
  expect(parseCalculationBackend({ compute_backend: native })).toEqual(native);
  expect(parseCalculationBackend({ compute_backend: julia })).toEqual(julia);
  for (const patch of [{ id: 'other' }, { jacobian: 'julia' }, { library_sha256: '' }, { adapter_sha256: undefined },
    { julia_core_sha256: 'a'.repeat(63) }, { version: {} }, { linear_solver: 'pcg' }]) {
    expect(() => parseCalculationBackend({ compute_backend: { ...native, ...patch } })).toThrow();
  }
  expect(() => parseCalculationBackend({ compute_backend: { ...julia, library_sha256: {} } })).toThrow();
});
test('explicit selection cannot accept silent fallback or missing metadata', () => {
  requireSelectedBackend({ compute_backend: native }, 'julia-rust-jacobian');
  expect(() => requireSelectedBackend({ compute_backend: julia }, 'julia-rust-jacobian')).toThrow('не подтвердил');
  expect(() => requireSelectedBackend(undefined, 'julia')).toThrow('не подтвердил');
});
test('discovery validates IDs, duplicates, availability and abortion', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const value of [[], ['other'], ['julia', 'julia'], 'julia', null]) {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ compute_backends: value })));
    await expect(getComputeBackends(new AbortController().signal)).rejects.toThrow();
  }
  fetcher.mockResolvedValue(new Response(JSON.stringify({ compute_backends: ['julia', 'julia-rust-jacobian'] })));
  expect(await getComputeBackends(new AbortController().signal)).toEqual(['julia', 'julia-rust-jacobian']);
  fetcher.mockResolvedValue(new Response('{}', { status: 503 }));
  await expect(getComputeBackends(new AbortController().signal)).rejects.toThrow();
  const cancelled = new AbortController(); cancelled.abort();
  const before = fetcher.mock.calls.length;
  await expect(getComputeBackends(cancelled.signal)).rejects.toThrow();
  expect(fetcher.mock.calls).toHaveLength(before);
});
