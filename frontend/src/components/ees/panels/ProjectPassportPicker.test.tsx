// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectPassportPicker } from './ProjectPassportPicker';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); });

test('pagination retains its cursor on error, supports retry and aborts reads on close', async () => {
  const read = vi.fn().mockResolvedValueOnce({ items: [], nextAfterId: '20' }).mockRejectedValueOnce(new Error('Паспорта недоступны')).mockResolvedValue({ items: [], nextAfterId: '' });
  await act(async () => root.render(<ProjectPassportPicker read={read} typeCode="generator" selected={null} onSelect={() => {}} disabled={false} template={[]} />));
  const button = (text: string) => [...host.querySelectorAll('button')].find(button => button.textContent === text)!;
  await act(async () => button('Следующие паспорта').click());
  expect(host.textContent).toContain('Паспорта недоступны');
  expect(read.mock.calls[0][0].aborted).toBe(true);
  await act(async () => button('Повторить загрузку паспортов').click());
  expect(read.mock.calls.map(call => call[1])).toEqual(['', '20', '20']);
  const signal = read.mock.calls[2][0];
  await act(async () => root.render(null)); expect(signal.aborted).toBe(true);
});

test('a late result from the previous reader cannot replace the new project list', async () => {
  let finish!: (value: { items: []; nextAfterId: string }) => void;
  const oldRead = vi.fn(() => new Promise<{ items: []; nextAfterId: string }>(resolve => { finish = resolve; }));
  const newRead = vi.fn().mockResolvedValue({ items: [], nextAfterId: '' });
  const props = { typeCode: 'generator', selected: null, onSelect: () => {}, disabled: false, template: [] };
  await act(async () => root.render(<ProjectPassportPicker {...props} read={oldRead} />));
  await act(async () => root.render(<ProjectPassportPicker {...props} read={newRead} />));
  await act(async () => finish({ items: [], nextAfterId: '20' }));
  expect(host.textContent).not.toContain('Следующие паспорта');
  expect(oldRead.mock.calls[0]).toBeDefined();
});
