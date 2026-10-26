// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectSchemes } from './ProjectSchemes';
import { listProjectSchemes, readProjectScheme, SessionError } from '../../api/projects-api';
vi.mock('../../api/projects-api', async importOriginal => ({ ...await importOriginal<typeof import('../../api/projects-api')>(), listProjectSchemes:vi.fn(), readProjectScheme:vi.fn(), createProjectScheme:vi.fn() }));
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.resetAllMocks(); Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true}); host=document.createElement('div'); root=createRoot(host);
  vi.mocked(listProjectSchemes).mockResolvedValue({items:[{id:'1',name:'Scheme A',description:''},{id:'2',name:'Scheme B',description:''}],nextAfterId:''}); });
afterEach(async () => { await act(async () => root.unmount()); });
test('viewer sees schemes without a creation form',async () => {
  vi.mocked(readProjectScheme).mockResolvedValue({id:'1',projectId:'8',name:'Graph',description:'',topologyRevision:'0',components:[],connections:[]});
  await act(async () => root.render(<ProjectSchemes identity={{accountId:'1',sessionId:'2',expiresAt:'2099-01-01T00:00:00Z'}} project={{id:'8',name:'Private',role:'viewer'}} onBack={()=>{}} />));
  expect(host.textContent).toContain('Scheme A'); expect(host.querySelector('form')).toBeNull();
  await act(async () => [...host.querySelectorAll('button')].find(button=>button.textContent==='Scheme A')!.click());
  expect(host.textContent).toContain('Graph');
  expect([...host.querySelectorAll('button')].some(button=>button.textContent==='Редактировать схему')).toBe(false);
});
test('revoked access clears the graph and asks the parent to revalidate the session',async () => {
  vi.mocked(listProjectSchemes).mockRejectedValue(new SessionError(404,'Unavailable'));
  const unavailable = vi.fn();
  await act(async () => root.render(<ProjectSchemes identity={{accountId:'1',sessionId:'2',expiresAt:'2099-01-01T00:00:00Z'}} project={{id:'8',name:'Private',role:'viewer'}} onBack={()=>{}} onUnavailable={unavailable} />));
  expect(unavailable).toHaveBeenCalledOnce();
  expect(host.querySelector('svg')).toBeNull();
  expect(host.textContent).not.toContain('Scheme A');
});
test('late private graph cannot return after switching projects',async () => {
  let resolve!: (data:unknown)=>void;
  vi.mocked(readProjectScheme).mockReturnValueOnce(new Promise(yes => {resolve=yes;})).mockResolvedValue({id:'2',projectId:'8',name:'Graph B',description:'',topologyRevision:'2',components:[],connections:[]});
  await act(async () => root.render(<ProjectSchemes identity={{accountId:'1',sessionId:'2',expiresAt:'2099-01-01T00:00:00Z'}} project={{id:'8',name:'Private',role:'owner'}} onBack={()=>{}} />));
  await act(async () => [...host.querySelectorAll('button')].find(button=>button.textContent==='Scheme A')!.click());
  // Selection hides the old list while fetching; re-rendering with another project
  // is the same boundary used by the keyed navigator.
  await act(async () => root.render(<ProjectSchemes identity={{accountId:'1',sessionId:'2',expiresAt:'2099-01-01T00:00:00Z'}} key="other" project={{id:'9',name:'Other',role:'viewer'}} onBack={()=>{}} />));
  await act(async () => resolve({id:'1',projectId:'8',name:'Old private graph',description:'',topologyRevision:'1',components:[],connections:[]}));
  expect(host.textContent).not.toContain('Old private graph');
});
