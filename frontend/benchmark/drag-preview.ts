import {connectionGeometry,createMoveGeometry} from '../src/components/ees/editor-geometry';
import {createEditorPicker} from '../src/components/ees/editor-picking';
import type {EditorComponent,EditorConnection} from '../src/components/ees/editor-utils';
const percentile=(a:number[],fraction:number)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*fraction))];

export function profile() {
  const cases=[];
  for(const count of [1000,10000,20000]) {
    const components:EditorComponent[]=Array.from({length:count},(_,i)=>({id:i+1,revision:'1',type:'transmission_line',typeId:1,
      name:`Line ${i}`,x:(i%100)*200,y:Math.floor(i/100)*150,rotation:(i%4)*90,params:{}}));
    const connections:EditorConnection[]=components.slice(1).map((c,i)=>({id:i+1,from:i+1,to:c.id,fromPort:'right',toPort:'left'}));
    const start=performance.now(),apply=createMoveGeometry(components,connections),adjacencySetupMs=performance.now()-start;
    const original=components[Math.floor(count/2)+24];
    const movement=(i:number)=>({componentId:original.id,x:original.x+i%40,y:original.y+i%20});
    for(let i=0;i<100;i++)apply(movement(i));
    const times:number[]=[];
    for(let i=0;i<1000;i++) {
      const start=performance.now(),result=apply(movement(i));times.push(performance.now()-start);
      if(result?.paths.size!==2 || result.connections.some(c=>c.from!==original.id && c.to!==original.id))throw new Error('Preview touched unrelated wires');
    }
    const before=performance.now(),pose=movement(39);
    const moved=components.map(c=>c.id===original.id?{...c,x:pose.x,y:pose.y}:c);
    const paths=connectionGeometry(moved,connections);
    createEditorPicker(moved,connections,paths);
    const fullGeometryRebuildMs=performance.now()-before;
    if(components[original.id-1]!==original || original.x!==((original.id-1)%100)*200)throw new Error('Committed graph mutated');
    cases.push({components:count,connections:connections.length,frames:times.length,adjacencySetupMs,
      previewGeometryMs:{p50:percentile(times,.5),p95:percentile(times,.95),max:Math.max(...times)},
      fullGeometryRebuildMs,incidentWires:2,committedGraphUnchanged:true});
  }
  return {schema_version:1,node:process.version,platform:process.platform,arch:process.arch,
    dataset:'100-column line grid at 200/150 spacing; rotations 0/90/180/270; move middle component with two incident wires by i%40/i%20',
    scope:'CPU preview geometry only, 100 warmup and 1000 measured frames. One full geometry/index rebuild sample per scene. Excludes React, SVG, FPS, request latency and committed-index incremental updates.',cases};
}
