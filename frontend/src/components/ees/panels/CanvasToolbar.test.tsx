// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CanvasToolbar } from './CanvasToolbar';
import type { ComputeBackendId } from '../../../api/compute-backends';
vi.mock('../../../api/ees-api', () => ({ getComputeCapabilities: async () => [{ model_group: 'three-phase', method: 'newton-raphson', status: 'experimental', reasons: [] }] }));
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const baseProps = { maxTimeMs: 20000, onMaxTimeChange: vi.fn(), currentSchemeId: 1, selectedComponent: null, selectedConnection: null, zoomPercent: 100,
  calcMethod: 'newton-raphson', modelGroup: 'three-phase', isCalculating: false, hasResult: false,
  computeBackend: 'julia-rust-jacobian' as ComputeBackendId, computeBackends: ['julia','julia-rust-jacobian'] as ComputeBackendId[], backendMessage: '',
  onBackendChange: vi.fn(), onBackendReload: vi.fn(), onCalcMethodChange: vi.fn(), onModelGroupChange: vi.fn(), onCalculate: vi.fn(),
  onShowResult: vi.fn(), onDeleteComponent: vi.fn(), onDeleteConnection: vi.fn(), onZoomIn: vi.fn(), onZoomOut: vi.fn(), onResetView: vi.fn() };
test('keeps an unavailable selected Rust backend and blocks calculation without silent fallback', async () => {
  await act(async () => root.render(<CanvasToolbar {...baseProps} />));
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Вычислительный движок"]')!;
  expect(select.value).toBe('julia-rust-jacobian');
  expect(host.querySelector<HTMLButtonElement>('.calculate-button')!.disabled).toBe(false);
  await act(async () => root.render(<CanvasToolbar {...baseProps} computeBackends={['julia']} />));
  expect(select.value).toBe('julia-rust-jacobian');
  expect(select.selectedOptions[0].disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('.calculate-button')!.disabled).toBe(true);
  expect(baseProps.onBackendChange).not.toHaveBeenCalled();
});
test('allows explicit selection and disables it during calculation', async () => {
  await act(async () => root.render(<CanvasToolbar {...baseProps} />));
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Вычислительный движок"]')!;
  await act(async () => { select.value = 'julia'; select.dispatchEvent(new Event('change',{bubbles:true})); });
  expect(baseProps.onBackendChange).toHaveBeenCalledWith('julia');
  await act(async () => root.render(<CanvasToolbar {...baseProps} isCalculating />));
  expect(select.disabled).toBe(true);
});

test('invalid or empty time budget blocks calculation and input uses explicit milliseconds', async () => {
  await act(async () => root.render(<CanvasToolbar {...baseProps} maxTimeMs={NaN} />));
  expect(host.querySelector<HTMLButtonElement>('.calculate-button')!.disabled).toBe(true);
  const input = host.querySelector<HTMLInputElement>('[aria-label="Бюджет времени, мс"]')!;
  expect(input.value).toBe('');
  expect(input.max).toBe('20000');
  await act(async () => root.render(<CanvasToolbar {...baseProps} maxTimeMs={5000} />));
  expect(input.value).toBe('5000');
  expect(host.querySelector<HTMLButtonElement>('.calculate-button')!.disabled).toBe(false);
});
