// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../../api/ees-api';
import { ModelSelectModal } from './ModelSelectModal';
import type { PassportVersion } from '../../../api/project-passports-api';
vi.mock('../../../api/ees-api', () => ({ getEquipmentModels: vi.fn(), getComponentParams: vi.fn(), getEquipmentModelParams: vi.fn() }));
const models = [{ id: 1, model_name: 'Alpha', manufacturer: 'Factory A', description: 'First' }, { id: 2, model_name: 'Beta', manufacturer: 'Factory B', description: 'Second' }];
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const confirm = vi.fn(async () => {});
async function click(text: string) { const element = [...host.querySelectorAll('label,button')].find(item => item.textContent === text || (item.tagName === 'LABEL' && item.textContent?.includes(text))); expect(element).toBeTruthy(); await act(async () => (element as HTMLElement).click()); }
async function mount() { await act(async () => root.render(<ModelSelectModal componentType={{ id: 1, code: 'generator', name: 'Генератор' }} onConfirm={confirm} onCancel={() => {}} />)); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(api.getEquipmentModels).mockResolvedValue(models);
  vi.mocked(api.getComponentParams).mockResolvedValue([{ key: 'p', name: 'Мощность', type: 'number', default: '999', unit: 'МВт' }]);
  vi.mocked(api.getEquipmentModelParams).mockImplementation(async id => ({ p: String(id) })); confirm.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });
async function fill(label: string, value: string) {
  const input = [...host.querySelectorAll('.creation-parameter-row label')].find(item => item.firstChild?.textContent === label)?.querySelector('input');
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('passport selection', () => {
  it('creates a manual value/unit pair, requires explicit units and keeps the draft after a failed save', async () => {
    await mount(); await click('Добавить параметр');
    await fill('Ключ', 'p'); await fill('Значение', '1.2300');
    await click('Добавить на схему');
    expect(confirm).not.toHaveBeenCalled(); expect(host.textContent).toContain('Укажите единицу');
    await fill('Единица', 'МВт');
    confirm.mockRejectedValueOnce(new Error('Ответ потерян'));
    await click('Добавить на схему');
    expect(confirm).toHaveBeenCalledWith(null, undefined, { params: { p: '1.2300' }, parameterUnitDeclaration: { formatVersion: 1, units: { p: 'МВт' } } });
    expect(host.textContent).toContain('Ответ потерян');
    expect((host.querySelector('.creation-parameter-row input') as HTMLInputElement).value).toBe('p');
    expect(host.querySelectorAll('.creation-parameter-row')).toHaveLength(1);
  });
  it('clears overrides when the passport changes but keeps them while comparing and searching', async () => {
    await mount(); await click('Alpha'); await click('Добавить параметр');
    await fill('Ключ', 'p'); await fill('Значение', '2.000'); await fill('Единица', 'МВт');
    await click('Beta');
    expect(host.querySelectorAll('.creation-parameter-row')).toHaveLength(0);
    await click('Добавить на схему'); expect(confirm).toHaveBeenCalledWith(2);
  });
  it('shows exact project version values, filters types and confirms its separate identity', async () => {
    const version: PassportVersion = { id: '9007199254740993', projectId: '1', authorAccountId: '1', predecessorId: null, revision: 1, status: 'draft', sha256: 'a'.repeat(64), createdAt: '2026-10-21T00:00:00Z',
      document: { formatVersion: 1, componentTypeCode: 'generator', name: 'Проектный источник', manufacturer: '', source: 'Учебный пример', license: 'Авторская декларация', parameters: { power_nom: { value: '10.00', unit: 'МВА' } } } };
    const read = vi.fn().mockResolvedValue({ items: [version, { ...version, id: '2', document: { ...version.document, componentTypeCode: 'load', name: 'Другая нагрузка' } }], nextAfterId: '' });
    await act(async () => root.render(<ModelSelectModal componentType={{ id: 1, code: 'generator', name: 'Генератор' }} projectPassports={read} onConfirm={confirm} onCancel={() => {}} />));
    const source = [...host.querySelectorAll('select')].find(item => item.parentElement?.textContent?.startsWith('Источник паспорта'))!;
    await act(async () => { source.value = 'project'; source.dispatchEvent(new Event('change', { bubbles: true })); });
    expect((host.querySelector('.dialog-actions .primary') as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).not.toContain('Другая нагрузка');
    await click('Проектный источник');
    expect(host.textContent).toContain('10.00'); expect(host.textContent).toContain('МВА'); expect(host.textContent).toContain('Учебный пример');
    await click('Добавить на схему');
    expect(confirm).toHaveBeenCalledWith(null, version.id);
    expect(api.getEquipmentModelParams).not.toHaveBeenCalled();
  });
  it('dispatches a single creation when confirmation is clicked twice before React commits busy state', async () => {
    let finish!: () => void;
    confirm.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await mount(); await click('Alpha');
    const button = host.querySelector('.dialog-actions .primary') as HTMLButtonElement;
    await act(async () => { button.click(); button.click(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(1);
    expect(button.disabled).toBe(true);
    await act(async () => finish());
  });

  it('releases the confirmation guard after failure and allows an explicit retry', async () => {
    confirm.mockRejectedValueOnce(new Error('Сохранение не подтверждено'));
    await mount(); await click('Alpha'); await click('Добавить на схему');
    expect(host.textContent).toContain('Сохранение не подтверждено');
    expect((host.querySelector('.dialog-actions .primary') as HTMLButtonElement).disabled).toBe(false);
    await click('Добавить на схему'); expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('filters, compares actual values and confirms the selected identity', async () => {
    await mount(); await click('Alpha');
    const select = host.querySelector('select:last-of-type');
    const comparison = [...host.querySelectorAll('select')].find(item => item.parentElement?.textContent?.includes('Сравнить с'))!;
    expect(select).toBeTruthy();
    await act(async () => { comparison.value = '2'; comparison.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('Различий в сохранённых значениях: 1'); expect(host.textContent).toContain('МВт'); expect(host.textContent).not.toContain('999');
    const search = host.querySelector('input[type=search]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Factory B'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.querySelectorAll('.passport-option')).toHaveLength(1);
    await click('Добавить на схему'); expect(confirm).toHaveBeenCalledWith(1);
  });
  it('ignores late parameter responses and blocks confirmation until the new passport loads', async () => {
    let first!: (value: Record<string, string>) => void; let second!: (value: Record<string, string>) => void;
    vi.mocked(api.getEquipmentModelParams).mockImplementation(id => new Promise(resolve => { if (id === 1) first = resolve; else second = resolve; }));
    await mount(); await click('Alpha'); await click('Beta');
    await act(async () => first({ p: 'STALE' }));
    expect(host.textContent).not.toContain('STALE');
    expect((host.querySelector('.dialog-actions .primary') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => second({ p: '42' })); await click('Добавить на схему'); expect(confirm).toHaveBeenCalledWith(2);
  });
  it('keeps manual entry and explicit overrides when a failed catalog is retried', async () => {
    vi.mocked(api.getEquipmentModels).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(models);
    await mount(); expect(host.textContent).toContain('Не удалось загрузить каталог');
    await click('Добавить на схему'); expect(confirm).toHaveBeenCalledWith(null); confirm.mockClear();
    await click('Добавить параметр'); await fill('Ключ', 'p'); await fill('Значение', '1.2300'); await fill('Единица', 'МВт');
    await click('Повторить загрузку каталога');
    expect(host.querySelectorAll('.creation-parameter-row')).toHaveLength(1);
    await click('Добавить на схему');
    expect(confirm).toHaveBeenCalledWith(null, undefined, { params: { p: '1.2300' }, parameterUnitDeclaration: { formatVersion: 1, units: { p: 'МВт' } } });
  });
  it('allows retry after a parameter error, without substituting defaults', async () => {
    vi.mocked(api.getEquipmentModelParams).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    await mount(); await click('Alpha'); expect((host.querySelector('.dialog-actions .primary') as HTMLButtonElement).disabled).toBe(true);
    await click('Повторить загрузку параметров'); expect(host.textContent).toContain('Не задано'); expect(host.textContent).not.toContain('999');
    await click('Добавить на схему'); expect(confirm).toHaveBeenCalledWith(1);
  });
});
