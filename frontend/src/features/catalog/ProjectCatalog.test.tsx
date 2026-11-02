// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '../../api/project-passports-api';
import * as catalog from '../../api/ees-api';
import { SessionError, type Project } from '../../api/projects-api';
import { ProjectCatalog } from './ProjectCatalog';
import { PassportForm } from './PassportForm';
vi.mock('../../api/project-passports-api', async original => ({ ...await original<typeof api>(), listProjectPassports: vi.fn(), readProjectPassport: vi.fn(), saveProjectPassport: vi.fn() }));
vi.mock('../../api/ees-api', () => ({ getComponentTypes: vi.fn(), getComponentParams: vi.fn() }));
const version: api.PassportVersion = { id: '1', projectId: '8', authorAccountId: '2', predecessorId: null, revision: 1, status: 'draft', sha256: 'a'.repeat(64), createdAt: '2026-10-20T12:00:00Z',
  document: { formatVersion: 1, componentTypeCode: 'generator', name: 'Old source', manufacturer: '', source: 'Source note', license: 'User data', parameters: { power_nom: { value: '10.00', unit: 'МВА' } } } };
const project: Project = { id: '8', name: 'Network', role: 'owner' };
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
async function click(text: string) { const b = [...host.querySelectorAll('button')].find(b => b.textContent === text); expect(b).toBeTruthy(); await act(async () => b!.click()); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks();
  vi.mocked(api.listProjectPassports).mockResolvedValue({ items: [version], nextAfterId: '' });
  vi.mocked(api.readProjectPassport).mockResolvedValue(version); vi.mocked(api.saveProjectPassport).mockResolvedValue(version);
  vi.mocked(catalog.getComponentTypes).mockResolvedValue([{ id: 1, code: 'generator', name: 'Генератор', category: 'source', description: '' }]);
  vi.mocked(catalog.getComponentParams).mockResolvedValue([{ key: 'power_nom', name: 'Номинальная мощность', type: 'number', unit: 'МВА', default: '999' }]);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const base = { profile: 'ac-three-phase-rms-v1' as const, s_base_mva: 10, v_base_kv: 35 };
const basedVersion = (): api.PassportVersion => ({ ...version, document: { ...version.document, formatVersion: 2, parameters: { power_nom: { value: '0.1000', unit: 'p.u.', base: { ...base } } } } });
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value); input.dispatchEvent(new Event('input',{ bubbles:true })); });
}
async function selectUnit(unit: string) {
  const select = host.querySelector('.passport-parameter-editor select')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,unit); select.dispatchEvent(new Event('change',{ bubbles:true })); });
}

test('revising p.u. preserves its source base, exact coefficient and uncertain-save identity', async () => {
  const original = basedVersion();
  vi.mocked(api.saveProjectPassport).mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<PassportForm projectId="8" original={original} mode="revise" onSaved={() => {}} onCancel={() => {}} onUnavailable={() => {}} />));
  const inputs = host.querySelectorAll<HTMLInputElement>('.parameter-base-fields input');
  expect([...inputs].map(input => input.value)).toEqual(['10','35']);
  expect(host.textContent).not.toContain('Сохранение заблокировано');
  await fill(host.querySelector<HTMLInputElement>('.passport-parameter-editor input')!,'0.2000');
  await click('Сохранить версию паспорта');
  const first = vi.mocked(api.saveProjectPassport).mock.calls[0][1];
  expect(first.document.parameters.power_nom).toEqual({ value:'0.2000', unit:'p.u.', base });
  expect(first.document.formatVersion).toBe(2);
  expect(original.document.parameters.power_nom.value).toBe('0.1000');
  original.document.parameters.power_nom.base!.s_base_mva=999;
  expect(first.document.parameters.power_nom.base).toEqual(base);
  await click('Повторить исходное сохранение');
  expect(vi.mocked(api.saveProjectPassport).mock.calls[1][1]).toEqual(first);
});

test('new p.u. representation requires explicit bases and changing back to dimensional clears only the copy', async () => {
  await act(async () => root.render(<PassportForm projectId="8" original={version} mode="clone" onSaved={() => {}} onCancel={() => {}} onUnavailable={() => {}} />));
  await selectUnit('p.u.');
  const inputs = host.querySelectorAll<HTMLInputElement>('.parameter-base-fields input');
  expect([...inputs].map(input => input.value)).toEqual(['','']);
  await click('Сохранить версию паспорта'); expect(api.saveProjectPassport).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Sб и Uб');
  await fill(inputs[0],'10'); await fill(inputs[1],'35');
  await click('Сохранить версию паспорта');
  expect(vi.mocked(api.saveProjectPassport).mock.calls[0][1].document.parameters.power_nom.base).toEqual(base);
  // Remount an independent clone of the immutable based source.
  await act(async () => root.render(<PassportForm key="based" projectId="8" original={basedVersion()} mode="clone" onSaved={() => {}} onCancel={() => {}} onUnavailable={() => {}} />));
  await selectUnit('МВА');
  expect(host.querySelector('.parameter-base-fields')).toBeNull();
  await click('Сохранить версию паспорта');
  expect(vi.mocked(api.saveProjectPassport).mock.calls[1][1].document.parameters.power_nom).toEqual({ value:'0.1000',unit:'МВА' });
});
test('viewer reads stored parameters and cannot create, revise or clone', async () => {
  await act(async () => root.render(<ProjectCatalog project={{ ...project, role: 'viewer' }} onBack={() => {}} />));
  await click('Открыть паспорт №1'); expect(host.textContent).toContain('10.00'); expect(host.textContent).not.toContain('999');
  expect(host.textContent).not.toContain('Новый паспорт'); expect(host.textContent).not.toContain('Клонировать как новый паспорт');
});
test('late private response is aborted and hidden after changing the project', async () => {
  let finish!: (v: api.PassportVersion) => void;
  vi.mocked(api.readProjectPassport).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<ProjectCatalog project={project} onBack={() => {}} />)); await click('Открыть паспорт №1');
  const signal = vi.mocked(api.readProjectPassport).mock.calls[0][2];
  vi.mocked(api.listProjectPassports).mockResolvedValue({ items: [], nextAfterId: '' });
  await act(async () => root.render(<ProjectCatalog project={{ ...project, id: '9' }} onBack={() => {}} />));
  expect(signal.aborted).toBe(true); await act(async () => finish(version)); expect(host.textContent).not.toContain('Old source');
});
test('an uncertain save retries the same document and command; double submission cannot duplicate it', async () => {
  let fail!: (e: Error) => void;
  vi.mocked(api.saveProjectPassport).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const saved = vi.fn();
  await act(async () => root.render(<PassportForm projectId="8" original={version} mode="revise" onSaved={saved} onCancel={() => {}} onUnavailable={() => {}} />));
  const form = host.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(api.saveProjectPassport).toHaveBeenCalledTimes(1);
  const first = vi.mocked(api.saveProjectPassport).mock.calls[0][1]; expect(first.predecessorId).toBe('1');
  await act(async () => fail(new Error('offline')));
  expect(host.querySelector('fieldset')!.disabled).toBe(true);
  await click('Повторить исходное сохранение');
  expect(api.saveProjectPassport).toHaveBeenCalledTimes(2); expect(vi.mocked(api.saveProjectPassport).mock.calls[1][1]).toEqual(first); expect(saved).toHaveBeenCalledTimes(1);
});
test('clone creates an independent root and rejected fields remain editable', async () => {
  vi.mocked(api.saveProjectPassport).mockRejectedValueOnce(new SessionError(400, 'Invalid parameters'));
  await act(async () => root.render(<PassportForm projectId="8" original={version} mode="clone" onSaved={() => {}} onCancel={() => {}} onUnavailable={() => {}} />));
  await click('Сохранить версию паспорта');
  const first = vi.mocked(api.saveProjectPassport).mock.calls[0][1]; expect(first.predecessorId).toBeNull(); expect(first.document.name).toContain('(копия)');
  expect(host.querySelector('fieldset')!.disabled).toBe(false); expect(host.textContent).toContain('Invalid parameters');
});
test('invalid local fields do not dispatch or freeze the draft', async () => {
  const invalid = { ...version, document: { ...version.document, source: ' ' } };
  await act(async () => root.render(<PassportForm projectId="8" original={invalid} mode="clone" onSaved={() => {}} onCancel={() => {}} onUnavailable={() => {}} />));
  await click('Сохранить версию паспорта'); expect(api.saveProjectPassport).not.toHaveBeenCalled();
  expect(host.querySelector('fieldset')!.disabled).toBe(false); expect(host.textContent).toContain('Заполните название');
});
test('changed template units cannot silently reinterpret a stored value', async () => {
  vi.mocked(catalog.getComponentParams).mockResolvedValue([{ key: 'power_nom', name: 'Мощность', type: 'number', unit: 'Вт', default: '999' }]);
  await act(async () => root.render(<PassportForm projectId="8" original={version} mode="revise" onSaved={() => {}} onCancel={() => {}} onUnavailable={() => {}} />));
  expect(host.textContent).toContain('Сохранение заблокировано');
  expect((host.querySelector('.primary') as HTMLButtonElement).disabled).toBe(true); expect(api.saveProjectPassport).not.toHaveBeenCalled();
});
test('revoked reads clear private cards and request session revalidation', async () => {
  vi.mocked(api.readProjectPassport).mockRejectedValueOnce(new SessionError(404, 'Denied')); const unavailable = vi.fn();
  await act(async () => root.render(<ProjectCatalog project={project} onBack={() => {}} onUnavailable={unavailable} />)); await click('Открыть паспорт №1');
  expect(unavailable).toHaveBeenCalledTimes(1); expect(host.textContent).not.toContain('Old source');
});
