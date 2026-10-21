// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectArchives } from './ProjectArchives';
import { ArchiveInputs } from './ArchiveInputs';
import { listCalculationArchives, readCalculationArchive, type CalculationArchive } from '../../api/calculation-archives-api';
import { SessionError } from '../../api/projects-api';
vi.mock('../../api/calculation-archives-api', () => ({ listCalculationArchives: vi.fn(), readCalculationArchive: vi.fn() }));
vi.mock('../../components/ees/panels/ResultsModal', () => ({ ResultsModal: ({ schemeName, context }: { schemeName: string; context: React.ReactNode }) => <div role="dialog">{schemeName}{context}</div> }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const item: CalculationArchive = { id: '1', schemeId: '7', schemeName: 'Old graph', authorAccountId: '2', topologyRevision: '0', modelGroup: 'three-phase', method: 'newton-raphson', createdAt: '2026-10-19T12:00:00Z', inputSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), inputBytes: 1, resultBytes: 1 };
const project = { id: '8', name: 'Private', role: 'viewer' as const };
beforeEach(() => { vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); root = createRoot(host); vi.mocked(listCalculationArchives).mockResolvedValue({ items: [item], nextBeforeId: '' }); });
afterEach(async () => { await act(async () => root.unmount()); });
const open = async () => act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Открыть расчёт №1')!.click());
test('viewer can open saved inputs without reading or editing the live scheme', async () => {
  vi.mocked(readCalculationArchive).mockResolvedValue({ metadata: item, input: { components: [], connections: [], modelGroup: item.modelGroup, method: item.method }, result: { success: true, node_count: 0, nodes: [], iterations: 0, computation_time_ms: 0, method_used: 'fixture' } });
  await act(async () => root.render(<ProjectArchives project={project} onBack={() => {}} />)); await open();
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Old graph'); expect(host.textContent).toContain('Исходные данные');
  expect(readCalculationArchive).toHaveBeenCalledWith('8', '1', expect.any(AbortSignal));
});
test('late payload is aborted and cannot appear after switching projects', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof readCalculationArchive>>) => void;
  vi.mocked(readCalculationArchive).mockReturnValue(new Promise(r => { resolve = r; }));
  await act(async () => root.render(<ProjectArchives project={project} onBack={() => {}} />)); await open();
  const signal = vi.mocked(readCalculationArchive).mock.calls[0][2];
  vi.mocked(listCalculationArchives).mockResolvedValue({ items: [], nextBeforeId: '' });
  await act(async () => root.render(<ProjectArchives project={{ ...project, id: '9' }} onBack={() => {}} />));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ metadata: item } as Awaited<ReturnType<typeof readCalculationArchive>>));
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(host.textContent).not.toContain('Old graph');
});
test('revoked access clears the page and asks the parent to revalidate', async () => {
  const unavailable = vi.fn(); vi.mocked(readCalculationArchive).mockRejectedValue(new SessionError(404, 'Denied'));
  await act(async () => root.render(<ProjectArchives project={project} onBack={() => {}} onUnavailable={unavailable} />)); await open();
  expect(unavailable).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('Old graph');
});
test('snapshot tables paginate at 50 rows and retain original parameter strings', async () => {
  const input = { modelGroup: 'three-phase', method: 'newton-raphson', connections: [], components: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, type: 'load', x: 0, y: 0, rotation: 0, params: { p: '0.0000100' } })) };
  await act(async () => root.render(<ArchiveInputs input={input} />)); expect(host.querySelectorAll('tbody tr')).toHaveLength(50);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Далее: Оборудование снимка"]')!.click());
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Объект №51')!.click());
  expect(host.textContent).toContain('0.0000100'); expect(host.querySelectorAll('tbody tr')).toHaveLength(51);
});
