// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ResultBackend } from './ResultBackend';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
test('historical result does not acquire a fabricated default backend', async () => {
  await act(async () => root.render(<ResultBackend />));
  expect(host.textContent).toContain('движок не указан');
  expect(host.textContent).not.toContain('Julia');
  expect(host.textContent).not.toContain('Бюджет времени');
});

test('shows only the execution budget actually reported in the result', async () => {
  await act(async () => root.render(<ResultBackend execution={{ policy: 'cooperative-checkpoints-v1', max_time_ms: 5000, native_calls_interruptible: false, disconnect_cancels: false }} />));
  expect(host.textContent).toContain('Бюджет времени: 5 с');
  expect(host.textContent).toContain('проверка между этапами');
});
test('shows actual Rust assembly, Julia runtime, linear solver and fingerprints', async () => {
  await act(async () => root.render(<ResultBackend backend={{ id: 'julia-rust-jacobian', version: 'c-abi-v1',
    julia_version: '1.10.12', jacobian: 'rust', linear_solver: 'umfpack', library_sha256: 'a'.repeat(64) }} />));
  expect(host.textContent).toContain('Julia + Rust');
  expect(host.textContent).toContain('экспериментальный');
  expect(host.textContent).toContain('UMFPACK');
  expect(host.textContent).toContain('a'.repeat(64));
});
