import { afterEach, expect, test, vi } from 'vitest';
import { ComponentWriteError, parseComponentRevision, parseCreatedComponent } from './component-revision';
import { deleteComponent, getScheme, patchComponent, setComponentParam, updateComponent } from './ees-api';

afterEach(() => vi.unstubAllGlobals());

test('revision parsing preserves the entire positive BIGINT range', () => {
  for (const value of ['1', '9007199254740993', '9223372036854775807']) expect(parseComponentRevision(value)).toBe(value);
  for (const value of [undefined, null, 1, Number('9007199254740993'), '', '0', '-1', '+1', '01', '1.0', ' 1', '1\n', '1\r', '9223372036854775808', '10000000000000000000']) {
    expect(() => parseComponentRevision(value)).toThrow('ревизию');
  }
});

test('every component write sends the precise If-Match token and reads the acknowledgement', async () => {
  const reply = { success: true, revision: '9007199254740994' };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => reply });
  vi.stubGlobal('fetch', fetch);
  expect(await updateComponent(1, 2, 3, 90, 'Шина', '9007199254740993')).toEqual(reply);
  expect(await setComponentParam(1, 'p', '', '9007199254740993')).toEqual(reply);
  expect(await deleteComponent(1, '9007199254740993')).toEqual(reply);
  for (const [, init] of fetch.mock.calls) expect(init.headers['If-Match']).toBe('"9007199254740993"');
  expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(['PUT', 'POST', 'DELETE']);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ x: 2, y: 3, rotation: 90, name: 'Шина' });
});

test('a conflict stays distinguishable from missing objects and network failure', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 412, json: async () => ({ code: 'component_revision_conflict', error: 'Оборудование изменено другим клиентом' }) });
  vi.stubGlobal('fetch', fetch);
  await expect(deleteComponent(1, '3')).rejects.toMatchObject({ name: 'ComponentWriteError', status: 412, code: 'component_revision_conflict' });
  fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ code: 'component_not_found', error: 'Оборудование не найдено' }) });
  await expect(deleteComponent(1, '3')).rejects.toBeInstanceOf(ComponentWriteError);
});

test('malformed acknowledgement never confirms a write', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const reply of [{ success: false, revision: '2' }, { success: true }, { success: true, revision: 2 }, { success: true, revision: '01' }, null]) {
    fetch.mockResolvedValue({ ok: true, json: async () => reply });
    await expect(setComponentParam(1, 'p', '10', '1')).rejects.toThrow();
  }
  fetch.mockClear();
  await expect(deleteComponent(1, '01')).rejects.toThrow('ревизию');
  expect(fetch).not.toHaveBeenCalled();
});

test('a scheme without valid component versions is rejected before editing', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const revision of [undefined, 1, '0']) {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 1, components: [{ id: 101, revision }] }) });
    await expect(getScheme(1)).rejects.toThrow('ревизию');
  }
});

test('creation validates the acknowledged snapshot rather than guessing its revision', () => {
  const created = { success: true, id: 101, revision: '8', params: { p: '10' }, equipmentModelId: null };
  expect(parseCreatedComponent(created)).toEqual(created);
  for (const fields of [{ success: false }, { revision: undefined }, { id: -1 }, { params: { p: 10 } }, { equipmentModelId: 0 }]) {
    expect(() => parseCreatedComponent({ ...created, ...fields })).toThrow();
  }
});

test('selected pose and parameters share one PATCH and exact precondition', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, revision: '11' }) });
  vi.stubGlobal('fetch', fetch);
  const patch = { pose: { x: 0 }, params: { p: '' } };
  expect(await patchComponent(101, patch, '8')).toEqual({ success: true, revision: '11' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].method).toBe('PATCH');
  expect(fetch.mock.calls[0][1].headers['If-Match']).toBe('"8"');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(patch);
  fetch.mockResolvedValue({ ok: false, status: 412, json: async () => ({ code: 'component_revision_conflict', error: 'Версия устарела' }) });
  await expect(patchComponent(101, patch, '8')).rejects.toMatchObject({ status: 412, code: 'component_revision_conflict' });
});
