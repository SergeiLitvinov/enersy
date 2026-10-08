// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GraphRecoveryDialog } from './GraphRecoveryDialog';
import type { GraphReview } from '../graph-writes';
vi.mock('../../ui/Dialog', () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); });
const review: GraphReview = { schemeId: 1, server: { id: 1, components: [], connections: [] }, failures: [
  { id: 7, intent: { kind: 'delete-connection', id: 201 }, reason: 'lost acknowledgement' },
] };
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!;
test('retry requires a single creation and its own confirmation, independently of server acceptance', async () => {
  const creationReview: GraphReview = { ...review, failures: [{ id: 8, reason: 'lost', intent: {
    kind: 'create-connection', commandId: '11111111-1111-4111-8111-111111111111', from: 2, to: 3, fromPort: 'a', toPort: 'b',
  } }] };
  const retry = vi.fn(async () => {}), accept = vi.fn(async () => {});
  await act(async () => root.render(<GraphRecoveryDialog onRead={async () => creationReview} onAccept={accept} onRetry={retry} onClose={() => {}} />));
  expect(button('Повторить создание связи').disabled).toBe(true);
  await act(async () => (container.querySelector('input') as HTMLInputElement).click());
  expect(button('Повторить создание связи').disabled).toBe(true);
  await act(async () => container.querySelectorAll<HTMLInputElement>('input')[2].click());
  expect(button('Принять состав для выбранных').disabled).toBe(true);
  await act(async () => button('Повторить создание связи').click());
  expect(retry).toHaveBeenCalledWith(creationReview, 8);
  expect(accept).not.toHaveBeenCalled();
});
test('acceptance requires selected intentions and a separate confirmation', async () => {
  const accept = vi.fn(async () => {}), close = vi.fn();
  await act(async () => root.render(<GraphRecoveryDialog onRead={async () => review} onAccept={accept} onClose={close} />));
  expect(button('Принять состав для выбранных').disabled).toBe(true);
  const checks = container.querySelectorAll<HTMLInputElement>('input');
  await act(async () => checks[0].click());
  expect(button('Принять состав для выбранных').disabled).toBe(true);
  await act(async () => checks[1].click());
  await act(async () => button('Принять состав для выбранных').click());
  expect(accept).toHaveBeenCalledWith(review, new Set([7]));
  expect(close).toHaveBeenCalledOnce();
});
test('failed reading never presents an empty topology as confirmed', async () => {
  const accept = vi.fn();
  await act(async () => root.render(<GraphRecoveryDialog onRead={async () => { throw new Error('network unavailable'); }} onAccept={accept} onClose={() => {}} />));
  expect(container.querySelector('[role=alert]')?.textContent).toBe('network unavailable');
  expect(container.querySelector('table')).toBeNull();
  expect(button('Принять состав для выбранных').disabled).toBe(true);
});
test('failed acceptance invalidates selection and requires a fresh comparison', async () => {
  const close = vi.fn(), read = vi.fn(async () => review);
  await act(async () => root.render(<GraphRecoveryDialog onRead={read} onAccept={async () => { throw new Error('stale comparison'); }} onClose={close} />));
  await act(async () => { container.querySelectorAll<HTMLInputElement>('input').forEach(check => check.click()); });
  await act(async () => button('Принять состав для выбранных').click());
  expect(close).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]')?.textContent).toBe('stale comparison');
  expect(button('Принять состав для выбранных').disabled).toBe(true);
  await act(async () => button('Обновить сравнение').click());
  expect(read).toHaveBeenCalledTimes(2);
  expect([...container.querySelectorAll<HTMLInputElement>('input')].every(input => !input.checked)).toBe(true);
});
