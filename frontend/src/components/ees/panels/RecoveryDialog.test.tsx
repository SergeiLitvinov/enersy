// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getScheme, type Scheme } from '../../../api/ees-api';
import { RecoveryDialog } from './RecoveryDialog';
import type { ComponentDraft } from '../component-drafts';

vi.mock('../../../api/ees-api', () => ({ getScheme: vi.fn() }));
vi.mock('../../ui/Dialog', () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const draft: ComponentDraft = { schemeId: 1, componentId: 101, reason: 'conflict', intents: [{ kind: 'pose', values: { x: 20 } }],
  base: { id: 101, revision: '1', type: 'busbar', typeId: 1, name: 'Bus', x: 0, y: 0, rotation: 0, params: {} } };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); });

test('failed read remains an error and never claims the object was deleted', async () => {
  vi.mocked(getScheme).mockRejectedValue(new Error('network unavailable'));
  await act(async () => root.render(<RecoveryDialog draft={draft} onClose={() => {}} />));
  expect(container.querySelector('[role=alert]')?.textContent).toBe('network unavailable');
  expect(container.textContent).not.toContain('Объект отсутствует');
  expect(container.querySelector('table')).toBeNull();
});

test('a late earlier comparison cannot replace the refreshed server version', async () => {
  let resolve!: (value: Scheme) => void;
  vi.mocked(getScheme).mockReturnValueOnce(new Promise< Scheme >(yes => { resolve = yes; }));
  vi.mocked(getScheme).mockResolvedValue({ id: 1, name: '', description: '', created_at: '', updated_at: '', owner_id: 1, components: [{ ...draft.base, revision: '8', x: 100 }] });
  await act(async () => root.render(<RecoveryDialog draft={draft} onClose={() => {}} />));
  // Mounting a new object invalidates the earlier pending read.
  await act(async () => root.render(<RecoveryDialog draft={{ ...draft, componentId: 102 }} onClose={() => {}} />));
  await act(async () => resolve({ id: 1, name: '', description: '', created_at: '', updated_at: '', owner_id: 1, components: [{ ...draft.base, id: 102, revision: '2', x: 20 }] }));
  expect(container.textContent).toContain('Объект отсутствует');
  expect(container.textContent).not.toContain('версия сервера 2');
});

const serverScheme: Scheme = { id: 1, name: '', description: '', created_at: '', updated_at: '', owner_id: 1, components: [{ ...draft.base, revision: '8', x: 100 }] };
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
async function chooseX() {
  await act(async () => (container.querySelector('input[type=checkbox]') as HTMLInputElement).click());
}

test('apply requires explicit selection and passes exactly the reviewed field and server version', async () => {
  vi.mocked(getScheme).mockResolvedValue(serverScheme);
  const resolve = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<RecoveryDialog draft={draft} onClose={() => {}} onResolve={resolve} />));
  expect(button('Применить мои значения').disabled).toBe(true);
  await chooseX();
  await act(async () => button('Применить мои значения').click());
  expect(resolve).toHaveBeenCalledWith(draft, serverScheme.components![0], new Set(['pose:x']), 'apply');
  expect(button('Применить мои значения').disabled).toBe(true);
});

test('acceptance uses a separate explicit action and preserves unselected deletion', async () => {
  vi.mocked(getScheme).mockResolvedValue(serverScheme);
  const resolve = vi.fn().mockResolvedValue(undefined);
  const withDelete: ComponentDraft = { ...draft, intents: [...draft.intents, { kind: 'delete' }] };
  await act(async () => root.render(<RecoveryDialog draft={withDelete} onClose={() => {}} onResolve={resolve} />));
  const inputs = container.querySelectorAll('input');
  expect(inputs[1].disabled).toBe(true);
  await chooseX();
  await act(async () => button('Принять серверные').click());
  expect(resolve).toHaveBeenCalledWith(withDelete, serverScheme.components![0], new Set(['pose:x']), 'accept');
});

test('pending resolution disables repeated submission and closing, then shows rejection and rereads', async () => {
  vi.mocked(getScheme).mockResolvedValue(serverScheme);
  let reject!: (error: Error) => void;
  const resolve = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  const close = vi.fn();
  await act(async () => root.render(<RecoveryDialog draft={draft} onClose={close} onResolve={resolve} />));
  await chooseX();
  await act(async () => button('Применить мои значения').click());
  expect([...container.querySelectorAll('button')].every(item => item.disabled)).toBe(true);
  await act(async () => button('Оставить правки в журнале').click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error('412: повторите сравнение')));
  expect(container.querySelector('[role=alert]')?.textContent).toContain('412');
  expect(getScheme).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(button('Применить мои значения').disabled).toBe(true);
});

test('a late resolution error cannot enter a different object comparison', async () => {
  vi.mocked(getScheme).mockResolvedValue(serverScheme);
  let reject!: (error: Error) => void;
  const resolve = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  await act(async () => root.render(<RecoveryDialog draft={draft} onClose={() => {}} onResolve={resolve} />));
  await chooseX();
  await act(async () => button('Применить мои значения').click());
  await act(async () => root.render(<RecoveryDialog draft={{ ...draft, componentId: 102 }} onClose={() => {}} onResolve={resolve} />));
  await act(async () => reject(new Error('old object failure')));
  expect(container.textContent).not.toContain('old object failure');
  expect(button('Оставить правки в журнале').disabled).toBe(false);
  expect(getScheme).toHaveBeenCalledTimes(2);
});

test('retry deletion requires its own explicit confirmation and leaves field selection independent', async () => {
  vi.mocked(getScheme).mockResolvedValue(serverScheme);
  const resolve = vi.fn().mockResolvedValue(undefined);
  const withDelete: ComponentDraft = { ...draft, intents: [...draft.intents, { kind: 'delete' }] };
  await act(async () => root.render(<RecoveryDialog draft={withDelete} onClose={() => {}} onResolveDeletion={resolve} />));
  expect(button('Удалить по серверной версии').disabled).toBe(true);
  const confirmation = [...container.querySelectorAll('input')].find(input => input.parentElement?.textContent?.includes('Подтверждаю удаление'))!;
  await act(async () => confirmation.click());
  await act(async () => button('Удалить по серверной версии').click());
  expect(resolve).toHaveBeenCalledWith(withDelete, serverScheme.components![0], 'delete');
  expect(button('Удалить по серверной версии').disabled).toBe(true);
});

test('missing object offers acknowledgement of absence and keeping an existing object requires no delete confirmation', async () => {
  const withDelete: ComponentDraft = { ...draft, intents: [{ kind: 'delete' }] };
  const resolve = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getScheme).mockResolvedValue({ ...serverScheme, components: [] });
  await act(async () => root.render(<RecoveryDialog draft={withDelete} onClose={() => {}} onResolveDeletion={resolve} />));
  expect(container.textContent).not.toContain('Удалить по серверной версии');
  await act(async () => button('Подтвердить отсутствие объекта').click());
  expect(resolve).toHaveBeenCalledWith(withDelete, undefined, 'delete');
  vi.mocked(getScheme).mockResolvedValue(serverScheme);
  await act(async () => root.render(<RecoveryDialog draft={{ ...withDelete }} onClose={() => {}} onResolveDeletion={resolve} />));
  await act(async () => button('Оставить объект на сервере').click());
  expect(resolve).toHaveBeenLastCalledWith(withDelete, serverScheme.components![0], 'keep');
});
