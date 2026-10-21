import { connectionGeometry,worldPorts,containsComponent,distanceToPolyline,type Point } from '../src/components/ees/editor-geometry';
import { createEditorPicker } from '../src/components/ees/editor-picking';
import type { EditorComponent,EditorConnection } from '../src/components/ees/editor-utils';

const percentile=(a:number[],fraction:number)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*fraction))];
export function profile() {
  const cases=[];
  for(const count of [1000,10000,20000]) {
    const components:EditorComponent[]=Array.from({length:count},(_,i)=>({id:i+1,revision:'1',type:'transmission_line',typeId:1,
      name:`Line ${i}`,x:(i%100)*200,y:Math.floor(i/100)*150,rotation:(i%4)*90,params:{}}));
    const connections:EditorConnection[]=components.slice(1).map((c,i)=>({id:i+1,from:i+1,to:c.id,fromPort:'right',toPort:'left'}));
    let start=performance.now();const paths=connectionGeometry(components,connections);const routingMs=performance.now()-start;
    start=performance.now();const picker=createEditorPicker(components,connections,paths);const indexMs=performance.now()-start;
    const baseline=(p:Point)=>{
      let port:string|null=null,body:number|null=null,wire:number|null=null;
      for(let i=components.length-1;i>=0 && port===null;i--) for(const q of worldPorts(components[i])) {
        if(Math.hypot(p.x-q.x,p.y-q.y)<=14) {port=`${components[i].id}:${q.name}`;break;}
      }
      for(let i=components.length-1;i>=0;i--) if(containsComponent(components[i],p)){body=components[i].id;break;}
      for(const c of connections){const points=paths.get(c.id);if(points && distanceToPolyline(p,points)<=8){wire=c.id;break;}}
      return {port,body,wire};
    };
    const indexed=(p:Point)=>{
      const port=picker.portAt(p,14);
      return {port:port?`${port.comp.id}:${port.port.name}`:null,body:picker.componentAt(p)?.id??null,wire:picker.connectionAt(p,8)?.id??null};
    };
    const points=Array.from({length:200},(_,i)=>{
      const ports=worldPorts(components[(i*97)%count]),p=ports[i%ports.length];
      return {x:p.x+(i%3-1)*4,y:p.y+(i%5-2)*3};
    });
    for(const p of points.slice(0,20)){baseline(p);indexed(p);}
    const directTimes:number[]=[],indexTimes:number[]=[],candidates:number[]=[],nodes:number[]=[];
    for(const p of points){
      start=performance.now();const direct=baseline(p);directTimes.push(performance.now()-start);
      start=performance.now();const actual=indexed(p);indexTimes.push(performance.now()-start);
      if(JSON.stringify(actual)!==JSON.stringify(direct))throw new Error('Picking parity failed');
      const stats=picker.candidateCounts(p,14);candidates.push(stats.bodies+stats.ports+stats.segments);nodes.push(stats.visitedNodes);
    }
    cases.push({components:count,connections:connections.length,queries:points.length,routingMs,indexMs,
      baselineQueryMs:{p50:percentile(directTimes,.5),p95:percentile(directTimes,.95)},
      indexedQueryMs:{p50:percentile(indexTimes,.5),p95:percentile(indexTimes,.95)},
      candidates:{p50:percentile(candidates,.5),p95:percentile(candidates,.95),max:Math.max(...candidates)},
      visitedNodesP95:percentile(nodes,.95),heapUsedMiB:process.memoryUsage().heapUsed/1024/1024,parity:true});
  }
  return {schema_version:1,node:process.version,platform:process.platform,arch:process.arch,
    dataset:'Deterministic 100-column line grid, 200/150 world-unit spacing, rotations 0/90/180/270; i*97 sample sequence',
    scope:'CPU routing/build/picking only; each query tests port, body and wire. Not browser frame time, drag latency, rendering, or an incremental index.',cases};
}
