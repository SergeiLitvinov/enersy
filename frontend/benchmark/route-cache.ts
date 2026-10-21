import {connectionGeometry} from '../src/components/ees/editor-geometry';
import {updateConnectionGeometry} from '../src/components/ees/editor-route-cache';
import type {EditorComponent,EditorConnection} from '../src/components/ees/editor-utils';

const percentile=(values:number[],fraction:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))];
const stats=(values:number[])=>({p50:percentile(values,.5),p95:percentile(values,.95),max:Math.max(...values)});

export function profile(){
  const cases=[];
  for(const count of [1000,10000,20000]){
    const components:EditorComponent[]=Array.from({length:count},(_,i)=>({id:i+1,type:'transmission_line',typeId:1,revision:'1',name:`Line ${i}`,
      x:(i%100)*200,y:Math.floor(i/100)*150,rotation:(i%4)*90,params:{}}));
    const connections:EditorConnection[]=components.slice(1).map((c,i)=>({id:i+1,from:i+1,to:c.id,fromPort:'right',toPort:'left'}));
    let snapshot=updateConnectionGeometry(null,components,connections,'scene');
    const target=components[Math.floor(count/2)+24],incremental:number[]=[],full:number[]=[];
    for(let frame=0;frame<35;frame++){
      const moved=components.map(c=>c.id===target.id?{...c,x:c.x+frame+1,y:c.y+frame+1}:c);
      let start=performance.now();
      const next=updateConnectionGeometry(snapshot,moved,connections,'scene');
      const updateMs=performance.now()-start;
      start=performance.now();
      const baseline=connectionGeometry(moved,connections);
      const fullMs=performance.now()-start;
      if(next.recomputedRoutes!==2)throw new Error('Unexpected routing work');
      for(const [id,path] of baseline){
        const actual=next.paths.get(id);
        if(JSON.stringify(path)!==JSON.stringify(actual))throw new Error('Incremental route differs from complete rebuild');
        const connection=connections[id-1];
        if(connection.from!==target.id && connection.to!==target.id && actual!==snapshot.paths.get(id))throw new Error('Unrelated path replaced');
      }
      if(frame>=5){incremental.push(updateMs);full.push(fullMs);}
      snapshot=next;
    }
    cases.push({components:count,connections:connections.length,samples:incremental.length,recomputedRoutes:2,
      reusedRoutes:connections.length-2,incrementalRouteUpdateMs:stats(incremental),fullRouteRebuildMs:stats(full),exactPathParity:true});
  }
  return {schema_version:1,node:process.version,platform:process.platform,arch:process.arch,
    dataset:'100-column line grid, spacing 200/150, rotations 0/90/180/270; middle object moves diagonally one unit per commit',
    scope:'CPU committed routing only; 5 warmup + 30 measured updates, complete-rebuild parity outside timing. Includes O(N+E) snapshot/map scans; excludes spatial indexes, adjacency rebuild, React, SVG, FPS and HTTP.',cases};
}
