// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ModelInspector } from './ModelInspector';
import * as api from '../../../api/model-definitions';
vi.mock('../../../api/model-definitions', () => ({ getModelDefinitions: vi.fn() }));
const fixture: api.ModelDefinitions = { schema_version: 1, kernel_version: '0.1.0', source_revision: 'a'.repeat(64), source_files: [{ path: 'backend-julia/src/models.jl', sha256: 'b'.repeat(64) }], model_group: 'three-phase', method: 'newton-raphson', status: 'experimental', definitions: [{ id: 'source', equipment_type: 'generator', name: 'Test source', implementation: 'generator_model', equations: ['E = V + ZI'], limitations: ['No dynamics'], nodes: [{id:'one',label:'Terminal',x:60,y:60,terminal:1},{id:'two',label:'Internal',x:240,y:60,terminal:0}], edges: [{id:'z',from:'one',to:'two',kind:'impedance',label:'Z'}] }] };
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
async function render(type = 'generator', active = true) { await act(async () => root.render(<ModelInspector equipmentType={type} active={active} />)); }
beforeEach(() => { Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true}); HTMLDialogElement.prototype.showModal=vi.fn();HTMLDialogElement.prototype.close=vi.fn(); host=document.createElement('div');document.body.append(host);root=createRoot(host);vi.mocked(api.getModelDefinitions).mockResolvedValue(fixture); });
afterEach(async () => { await act(async () => root.unmount());host.remove();vi.clearAllMocks(); });
test('loads only when opened and shows structure, equations, limitations and code identity', async () => {
  await render('generator',false);expect(api.getModelDefinitions).not.toHaveBeenCalled();await render();expect(host.querySelector('svg')?.getAttribute('aria-label')).toContain('Test source');expect(host.textContent).toContain('No dynamics');expect(host.textContent).toContain(fixture.source_revision);
});
test('does not substitute another type when its description is missing', async () => {
  await render('transformer');expect(host.textContent).toContain('описание ещё не опубликовано');expect(host.querySelector('svg')).toBeNull();
});

test('shows an ideal transformer with two windings and no conductor bypass', async () => {
  const data: api.ModelDefinitions = { ...fixture, schema_version: 3, definitions: [{ ...fixture.definitions[0],
    equipment_type: 'transformer', name: 'Двухобмоточный трансформатор', parameters: [],
    nodes: [{id:'hv',label:'HV',x:35,y:65,terminal:1},{id:'lv',label:'LV',x:325,y:65,terminal:2}],
    edges: [{id:'ratio',from:'hv',to:'lv',kind:'transformer',label:'1:k'}],
    limitations: ['Нейтраль и фазосдвиг не моделируются'] }] };
  vi.mocked(api.getModelDefinitions).mockResolvedValue(data);
  await render('transformer');
  const symbol = host.querySelector('[data-model-symbol="transformer"]')!;
  expect(symbol.querySelectorAll('circle.model-transformer-winding')).toHaveLength(2);
  const leads = [...symbol.querySelectorAll('line')];
  expect(leads).toHaveLength(2);
  expect(Number(leads[0].getAttribute('x1'))).toBe(35);
  expect(Number(leads[1].getAttribute('x2'))).toBe(325);
  expect(Number(leads[0].getAttribute('x2'))).toBeLessThan(Number(leads[1].getAttribute('x1')));
  expect(symbol.textContent).toBe('1:k');
  expect(host.textContent).toContain('Нейтраль и фазосдвиг не моделируются');
  await act(async()=>host.querySelector('button')!.click());
  expect(host.querySelector('dialog [data-model-symbol="transformer"]')).not.toBeNull();
});
test('ignores a late response from an earlier selected type', async () => {
  let resolve!: (value: api.ModelDefinitions)=>void;
  vi.mocked(api.getModelDefinitions).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  await render();await render('transformer');await act(async()=>resolve(fixture));expect(host.querySelector('svg')).toBeNull();expect(host.textContent).not.toContain('Test source');
});
test('shows a worker failure and allows retry without enabling a fake model', async () => {
  vi.mocked(api.getModelDefinitions).mockRejectedValueOnce(new Error('Worker offline'));await render();expect(host.textContent).toContain('Worker offline');expect(host.querySelector('svg')).toBeNull();await act(async()=>host.querySelector('button')!.click());expect(host.textContent).toContain('Test source');
});

test('expands a readable symbolic diagram and closes it when the model section is left', async () => {
  await render();await act(async()=>host.querySelector('button')!.click());expect(host.querySelector('dialog')?.getAttribute('aria-label')).toBe('Структура: Test source');
  await render('generator',false);expect(host.querySelector('dialog')).toBeNull();await render();expect(host.querySelector('dialog')).toBeNull();
});

test('changing equipment values of the same type updates the table without refetching or applying defaults', async () => {
  const data: api.ModelDefinitions = { ...fixture, schema_version: 2, definitions: fixture.definitions.map(item=>({...item, parameters:[{key:'p',name:'Power',unit:'MW',kind:'number',requirement:'required',default_value:null,note:'Three phase'}, {key:'r',name:'Resistance',unit:'Ohm',kind:'number',requirement:'optional',default_value:'0',note:'Per phase'}]})) };
  vi.mocked(api.getModelDefinitions).mockResolvedValue(data);
  const renderValues = async (params: Record<string,string>) => { await act(async()=>root.render(<ModelInspector equipmentType="generator" active params={params} />)); };
  await renderValues({p:'123'});expect(host.querySelector('.model-parameters')?.textContent).toContain('123');expect(host.querySelector('.model-parameters')?.textContent).toContain('Не задано');
  await renderValues({p:'456',r:'0'});const table=host.querySelector('.model-parameters')!;expect(table.textContent).toContain('456');expect(table.textContent).not.toContain('123');expect(table.textContent).not.toContain('Не задано');expect(api.getModelDefinitions).toHaveBeenCalledTimes(1);
});

test.each(['inductor', 'capacitor'] as const)('draws %s in the model with separated leads, never a wire bypass', async symbol => {
  const definition: api.ModelDefinition = { ...fixture.definitions[0],
    nodes: [{id:'a',label:'External',x:180,y:55,terminal:1},{id:'b',label:'Reference',x:180,y:165,terminal:0}],
    edges: [{id:'passive',from:'a',to:'b',kind:'impedance',label:'jX_L',symbol}] };
  vi.mocked(api.getModelDefinitions).mockResolvedValue({...fixture, definitions:[definition]});
  await render();
  const element = host.querySelector(`[data-model-symbol="${symbol}"]`)!;
  expect(element).not.toBeNull();
  const leads = [...element.querySelectorAll('line')];
  expect(leads).toHaveLength(2);
  expect(Number(leads[0].getAttribute('y1'))).toBe(55);
  expect(Number(leads[1].getAttribute('y2'))).toBe(165);
  expect(Number(leads[0].getAttribute('y2'))).toBeLessThan(Number(leads[1].getAttribute('y1')));
  expect(element.querySelector('rect')).toBeNull();
  expect(element.textContent).toContain('jX_L');
  expect(host.querySelector('svg')?.getAttribute('aria-label')).toContain('Test source');
});
