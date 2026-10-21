import {worldPorts} from '../src/components/ees/editor-geometry';
import {createEditorPicker} from '../src/components/ees/editor-picking';
import {updateConnectionGeometry} from '../src/components/ees/editor-route-cache';
import type {EditorComponent,EditorConnection} from '../src/components/ees/editor-utils';

const stats=(samples:number[])=>{
  const sorted=[...samples].sort((a,b)=>a-b);
  return {p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1)};
};
export function profile(){
  const cases=[];
  for(const count of [1000,10000,20000]){
    const components:EditorComponent[]=Array.from({length:count},(_,i)=>({id:i+1,type:'transmission_line',typeId:1,revision:'1',name:`Line ${i}`,
      x:(i%100)*200,y:Math.floor(i/100)*150,rotation:(i%4)*90,params:{}}));
    const connections:EditorConnection[]=components.slice(1).map((c,i)=>({id:i+1,from:i+1,to:c.id,fromPort:'right',toPort:'left'}));
    let routes=updateConnectionGeometry(null,components,connections,'scene');
    let picker=createEditorPicker(components,connections,routes.paths,null,'scene');
    const target=components[Math.floor(count/2)+24],updates:number[]=[],full:number[]=[],queries:number[]=[];
    for(let frame=0;frame<15;frame++){
      const moved=components.map(c=>c.id===target.id?{...c,x:c.x+frame+1,y:c.y+frame+1}:c);
      routes=updateConnectionGeometry(routes,moved,connections,'scene');
      let start=performance.now();
      const next=createEditorPicker(moved,connections,routes.paths,picker.snapshot,'scene');
      const updateMs=performance.now()-start;
      start=performance.now();
      const fresh=createEditorPicker(moved,connections,routes.paths,null,'scene');
      const fullMs=performance.now()-start;
      if(next.changedComponents!==1 || next.changedWires!==2)throw new Error('Unexpected index updates');
      for(let q=0;q<12;q++){
        const item=moved[q===0?target.id-1:(q*997+frame*17)%count];
        const p=worldPorts(item)[0];
        start=performance.now();
        const actual={body:next.componentAt(p)?.id??null,port:next.portTargetAt(p,14)?.comp.id??null,wire:next.connectionAt(p,8)?.id??null};
        const queryMs=performance.now()-start;
        const expected={body:fresh.componentAt(p)?.id??null,port:fresh.portTargetAt(p,14)?.comp.id??null,wire:fresh.connectionAt(p,8)?.id??null};
        if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Picking mismatch');
        const box={left:p.x-50,right:p.x+100,top:p.y-50,bottom:p.y+100};
        const visible=(index:typeof next)=>{const result=index.visibleIn(box);return {components:result.components.map(c=>c.id),connections:result.connections.map(c=>c.id)};};
        if(JSON.stringify(visible(next))!==JSON.stringify(visible(fresh)))throw new Error('Visibility mismatch');
        if(frame>=5)queries.push(queryMs);
      }
      if(frame>=5){updates.push(updateMs);full.push(fullMs);}
      picker=next;
    }
    cases.push({components:count,connections:connections.length,samples:updates.length,changedComponents:1,changedWires:2,
      indexUpdateMs:stats(updates),fullIndexBuildMs:stats(full),threeQueriesMs:stats(queries),
      overlayEntries:{bodies:picker.snapshot.bodies.overlaySize,visuals:picker.snapshot.visuals.overlaySize,
        ports:picker.snapshot.ports.overlaySize,segments:picker.snapshot.segments.overlaySize},exactPickingAndVisibilityParity:true});
  }
  return {schema_version:1,node:process.version,platform:process.platform,arch:process.arch,
    dataset:'100-column line grid at 200/150 spacing, rotations 0/90/180/270, one middle object with two incident wires moved diagonally',
    scope:'CPU picker snapshot/index update only, 5 warmup + 10 measured commits and 12 query triples per commit; full-build parity outside timing. Includes graph scans and current ID maps; excludes routing, adjacency, React, SVG, FPS, HTTP and rebase cost.',cases};
}
