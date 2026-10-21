// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NewSchemeDialog } from './NewSchemeDialog';

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const create = vi.fn<() => Promise<boolean>>();
const close = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
  create.mockReset().mockResolvedValue(true); close.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<NewSchemeDialog onCreate={create} onClose={close} />));
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' Сеть ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function submit() { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }

test('two batched submissions create one scheme and close only after success', async () => {
  let finish!: (created: boolean) => void;
  create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { submit(); submit(); });
  expect(create).toHaveBeenCalledExactlyOnceWith('Сеть', '');
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish(true)); expect(close).toHaveBeenCalledTimes(1);
});

test('a refused creation keeps the entered name and allows an explicit retry', async () => {
  create.mockResolvedValueOnce(false);
  await act(async () => submit());
  expect(close).not.toHaveBeenCalled(); expect(host.querySelector('input')!.value).toBe(' Сеть ');
  await act(async () => submit()); expect(create).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(1);
});

test('a rejected creation shows an error and releases the busy state for retry', async () => {
  create.mockRejectedValueOnce(new Error('offline'));
  await act(async () => submit());
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Не удалось создать схему');
  expect((host.querySelector('.primary') as HTMLButtonElement).disabled).toBe(false);
  expect(close).not.toHaveBeenCalled();
  await act(async () => submit()); expect(create).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(1);
});
