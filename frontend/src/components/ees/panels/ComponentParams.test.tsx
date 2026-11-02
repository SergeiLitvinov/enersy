// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EditorComponent } from '../editor-utils';
import { ComponentParams } from './ComponentParams';

vi.mock('../../ui/Dialog', () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const save = vi.fn();
const component: EditorComponent = { id: 1, type: 'busbar', typeId: 1, revision: '1', name: 'Bus', x: 0, y: 0, rotation: 0,
  params: { u: '110', i: '2000', enabled: 'true' },
  paramTemplate: ['u', 'i', 'enabled'].map(key => ({ key, name: key, type: key === 'enabled' ? 'boolean' : 'number', default: '', unit: '' })) };
const input = (key: string) => container.querySelector<HTMLInputElement>(`#param-1-${key}`)!;
test('parameter editing displays an explicit instance unit instead of a changed template', async () => {
  const declared = { ...component, declaredParameterUnits: { formatVersion: 1 as const, units: { u: 'kV' } }, paramTemplate: [{ key: 'u', name: 'U', type: 'number', default: '', unit: 'V' }] };
  await act(async () => root.render(<ComponentParams component={declared} onSave={save} />));
  expect(container.querySelector('.param-unit')?.textContent).toBe('kV');
  expect(input('u').value).toBe('110');
});

test('dirty parameter text is never saved under a newly declared unit, even if server number matches it', async () => {
  const source = { ...component, declaredParameterUnits: { formatVersion: 1 as const, units: { u: 'кВ' } } };
  await act(async () => root.render(<ComponentParams component={source} onSave={save} />));
  await type('u', '220');
  await act(async () => root.render(<ComponentParams component={{ ...source, params: { ...source.params, u: '220' }, declaredParameterUnits: { formatVersion: 1, units: { u: 'В' } } }} onSave={save} />));
  expect(input('u').value).toBe('220');
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Единица изменилась');
  await type('u', '330'); await act(async () => { input('u').focus(); input('u').blur(); });
  expect(save).not.toHaveBeenCalled();
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Вернуть сохранённое значение')!.click());
  expect(input('u').value).toBe('220'); expect(container.querySelector('[role=alert]')).toBeNull();
  await type('u', '330'); await act(async () => { input('u').focus(); input('u').blur(); });
  expect(save).toHaveBeenCalledWith('u', '330');
});
test('inspector identifies the fixed project passport version without converting its ID', async () => {
  await act(async () => root.render(<ComponentParams component={{ ...component, projectPassportVersionId: '9007199254740993' }} onSave={save} />));
  expect(container.textContent).toContain('версия #9007199254740993');
  expect(container.textContent).toContain('обновление паспорта её не меняет');
});

test('transformer shift field is explicit, saves through the existing queue and is not duplicated by templates', async () => {
  const transformer = { ...component, type: 'transformer', params: {} };
  await act(async () => root.render(<ComponentParams component={transformer} onSave={save} />));
  expect(input('phase_shift_deg').value).toBe('');
  expect(save).not.toHaveBeenCalled();
  await type('phase_shift_deg', '30');
  await act(async () => { input('phase_shift_deg').focus(); input('phase_shift_deg').blur(); });
  expect(save).toHaveBeenCalledWith('phase_shift_deg', '30');
  await act(async () => root.render(<ComponentParams component={{...transformer, params:{phase_shift_deg:'30'}, paramTemplate:[{key:'phase_shift_deg',name:'Shift',unit:'°',type:'number',default:''}]}} onSave={save} />));
  expect(container.querySelectorAll('#param-1-phase_shift_deg')).toHaveLength(1);
});
async function render(params = component.params, resets?: Record<string, number>) {
  await act(async () => root.render(<ComponentParams component={{ ...component, params }} onSave={save} parameterResets={resets} />));
}
async function type(key: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(key), value);
    input(key).dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => { save.mockReset(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('accepting a reviewed field displays the server value and cannot resubmit the rejected value on blur', async () => {
  await render(); await type('u', '750');
  await render({ ...component.params, u: '500' }, { u: 1 });
  expect(input('u').value).toBe('500');
  await act(async () => { input('u').focus(); input('u').blur(); });
  expect(save).not.toHaveBeenCalled();
});

test('partial review resets only selected fields, including acceptance of an unchanged server value', async () => {
  await render(); await type('u', '750'); await type('i', '3000');
  const current = input('i'); current.focus();
  await render(component.params, { u: 1 });
  expect(input('u').value).toBe('110'); expect(input('i').value).toBe('3000');
  expect(input('i')).toBe(current); expect(document.activeElement).toBe(current);
});

test('ordinary acknowledgements preserve focus and newer typing while clean fields follow confirmed data', async () => {
  await render(); await type('u', '220'); const current = input('u'); current.focus();
  await render({ ...component.params, u: '220', i: '2500', enabled: 'false' });
  expect(input('u')).toBe(current); expect(document.activeElement).toBe(current);
  expect(input('i').value).toBe('2500'); expect(input('enabled').checked).toBe(false);
  await type('u', '330');
  await render({ ...component.params, u: '250' });
  expect(input('u').value).toBe('330');
});

test('explicit acceptance also resets boolean input and clears a removed server parameter', async () => {
  await render(); await type('u', '750');
  await act(async () => input('enabled').click());
  await render({ i: '2000', enabled: 'true' }, { u: 1, enabled: 1 });
  expect(input('u').value).toBe(''); expect(input('enabled').checked).toBe(true);
});


test('an undeclared numeric field is read-only and opens its own value/unit form without template inference', async () => {
  const atomic = vi.fn();
  const source = { ...component, paramTemplate: component.paramTemplate!.map(p => ({ ...p, unit: p.key === 'i' ? 'A' : '' })) };
  await act(async () => root.render(<ComponentParams component={source} onSave={save} onSaveParams={atomic} />));
  expect(input('i').readOnly).toBe(true);
  expect(input('i').placeholder).toBe('Не задано');
  await type('i', '3000');
  await act(async () => { input('i').focus(); input('i').blur(); });
  expect(save).not.toHaveBeenCalled(); expect(atomic).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Задать значение и единицу: i"]')!.click());
  const form = container.querySelector('form')!;
  expect(form.querySelector('select')!.value).toBe('i');
  const fields = form.querySelectorAll('input');
  expect(fields[0].value).toBe('2000'); expect(fields[1].value).toBe(''); expect(fields[1].placeholder).toBe('A');
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(atomic).not.toHaveBeenCalled();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(fields[1], 'A');
    fields[1].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(atomic).toHaveBeenCalledWith({ i: '2000' }, { formatVersion: 1, units: { i: 'A' } });
  expect(save).not.toHaveBeenCalled();
});

test('ordinary declared numeric edits send the original explicit unit atomically and preserve a rejected draft', async () => {
  const atomic = vi.fn().mockRejectedValue(new Error('Revision conflict; review the journal'));
  const source = { ...component, declaredParameterUnits: { formatVersion: 1 as const, units: { u: 'кВ' } } };
  await act(async () => root.render(<ComponentParams component={source} onSave={save} onSaveParams={atomic} />));
  expect(input('u').readOnly).toBe(false);
  await type('u', '220.0000');
  await act(async () => { input('u').focus(); input('u').blur(); });
  expect(atomic).toHaveBeenCalledWith({ u: '220.0000' }, { formatVersion: 1, units: { u: 'кВ' } });
  expect(save).not.toHaveBeenCalled(); expect(input('u').value).toBe('220.0000');
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Revision conflict');
});

test('changed server units block the atomic edit too, while boolean controls keep their existing path', async () => {
  const atomic = vi.fn();
  const source = { ...component, declaredParameterUnits: { formatVersion: 1 as const, units: { u: 'кВ' } } };
  await act(async () => root.render(<ComponentParams component={source} onSave={save} onSaveParams={atomic} />));
  await type('u', '220');
  await act(async () => root.render(<ComponentParams component={{ ...source, params: { ...source.params, u: '220' }, declaredParameterUnits: { formatVersion: 1, units: { u: 'В' } } }} onSave={save} onSaveParams={atomic} />));
  await act(async () => { input('u').focus(); input('u').blur(); });
  expect(atomic).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Единица изменилась');
  await act(async () => input('enabled').click());
  expect(save).toHaveBeenCalledWith('enabled', 'false'); expect(atomic).not.toHaveBeenCalled();
});
