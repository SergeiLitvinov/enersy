import { expect, test } from 'vitest';
import { parseProjectGraph } from './project-graph';
import { getCompSize } from '../../components/ees/editor-utils';
const component = {id:'1',typeId:'2',type:'busbar',name:'Bus',x:100,y:100,rotation:90,revision:'9007199254740993',equipmentModelId:null,params:{voltage_nom:'110'}};
const graph = {id:'4',projectId:'9007199254740993',name:'Private graph',description:'',topologyRevision:'0',components:[component],connections:[]};
test('renderer conversion preserves exact parent IDs and revisions', () => {
  const parsed = parseProjectGraph(graph,graph.projectId,graph.id);
  expect(parsed.projectId).toBe('9007199254740993');
  expect(parsed.components[0].revision).toBe('9007199254740993');
  expect(parsed.components[0].id).toBe(1);
});
test('different parent, rounded IDs, incomplete graph and duplicate IDs are rejected', () => {
  expect(() => parseProjectGraph(graph,'7',graph.id)).toThrow();
  for (const replacement of [{id:1},{id:'9007199254740993'},{rotation:0.5},{x:Infinity},{params:{voltage_nom:110}},{revision:'0'},{revision:'9223372036854775808'}]) {
    expect(() => parseProjectGraph({...graph,components:[{...component,...replacement}]},graph.projectId,graph.id)).toThrow();
  }
  expect(() => parseProjectGraph({...graph,connections:null},graph.projectId,graph.id)).toThrow();
  expect(() => parseProjectGraph({...graph,components:[component,component]},graph.projectId,graph.id)).toThrow();
  expect(() => parseProjectGraph({...graph,topologyRevision:'9223372036854775808'},graph.projectId,graph.id)).toThrow();
});
test('unknown type names cannot inherit executable objects from symbol size maps', () => {
  expect(getCompSize('constructor')).toEqual({w:30,h:30});
  expect(getCompSize('__proto__')).toEqual({w:30,h:30});
});

test('project passport binding survives reload without BIGINT rounding', () => {
  const bound = { ...component, projectPassportVersionId: '9007199254740993' };
  const parsed = parseProjectGraph({ ...graph, components: [bound] }, graph.projectId, graph.id);
  expect(parsed.components[0].projectPassportVersionId).toBe('9007199254740993');
  for (const replacement of [{ projectPassportVersionId: 12 }, { projectPassportVersionId: '0' },
    { projectPassportVersionId: '9223372036854775808' }, { equipmentModelId: '1' }]) {
    expect(() => parseProjectGraph({ ...graph, components: [{ ...bound, ...replacement }] }, graph.projectId, graph.id)).toThrow();
  }
  expect(parseProjectGraph(graph, graph.projectId, graph.id).components[0].projectPassportVersionId).toBeNull();
});
