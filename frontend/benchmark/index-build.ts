import {readFileSync} from 'node:fs';
import {createEditorPicker} from '../src/components/ees/editor-picking';
import {updateConnectionGeometry} from '../src/components/ees/editor-route-cache';
import {worldPorts} from '../src/components/ees/editor-geometry';
import type {EditorComponent,EditorConnection} from '../src/components/ees/editor-utils';

const gc=(globalThis as typeof globalThis & {gc?:()=>void}).gc;
const collect=()=>{if(!gc)throw new Error('Run Node with --expose-gc');gc();};
const memory=()=>process.memoryUsage().heapUsed;
let retainedPicker:ReturnType<typeof createEditorPicker>|null=null;
function containerPeak(){try{return Number(readFileSync('/sys/fs/cgroup/memory.peak','utf8').trim());}catch{return null;}}

export async function profile(){
  const cases=[];
  for(const count of [1000,10000,20000])for(let trial=0;trial<3;trial++){
    const components:EditorComponent[]=Array.from({length:count},(_,i)=>({id:i+1,type:'transmission_line',typeId:1,revision:'1',name:`Line ${i}`,
      x:(i%100)*200,y:Math.floor(i/100)*150,rotation:(i%4)*90,params:{}}));
    const connections:EditorConnection[]=components.slice(1).map((c,i)=>({id:i+1,from:i+1,to:c.id,fromPort:'right',toPort:'left'}));
    let routes=updateConnectionGeometry(null,components,connections,'scene');
    collect();const beforeHeap=memory();
    let start=performance.now();
    let picker:ReturnType<typeof createEditorPicker>|null=createEditorPicker(components,connections,routes.paths,null,'scene');
    const initialBuildMs=performance.now()-start,heapAfterBuildBeforeGc=memory();
    collect();const initialRetainedHeap=memory();
    const initialPeak=containerPeak();
    const keysToChange=Math.max(picker.snapshot.bodies.rebaseLimit,picker.snapshot.visuals.rebaseLimit,
      picker.snapshot.ports.rebaseLimit,picker.snapshot.segments.rebaseLimit)+1;
    const moved=components.map((component,i)=>i<keysToChange?{...component,x:component.x+30,y:component.y+40}:component);
    routes=updateConnectionGeometry(routes,moved,connections,'scene');
    collect();const beforeRebaseHeap=memory();
    start=performance.now();
    const next=createEditorPicker(moved,connections,routes.paths,picker.snapshot,'scene');
    const rebaseMs=performance.now()-start,heapAfterRebaseBeforeGc=memory();
    collect();const retainedWithBothSnapshots=memory();
    const rebasePeak=containerPeak();
    const layers={bodies:next.snapshot.bodies.overlaySize,visuals:next.snapshot.visuals.overlaySize,
      ports:next.snapshot.ports.overlaySize,segments:next.snapshot.segments.overlaySize};
    if(Object.values(layers).some(size=>size!==0))throw new Error('Fixture did not compact all four indexes');
    // Query checks outside timers; old and new snapshots must coexist correctly.
    for(const index of [0,Math.floor(keysToChange/2),keysToChange-1,count-1]){
      const oldPort=worldPorts(components[index])[0],newPort=worldPorts(moved[index])[0];
      if(picker.portAt(oldPort,0)?.comp.id!==components[index].id || next.portAt(newPort,0)?.comp.id!==moved[index].id)throw new Error('Compaction changed exact port picking');
    }
    // Keep the new snapshot an explicit module root during GC; otherwise an
    // optimizer may release it too once the last query has completed.
    const oldSnapshot=new WeakRef(picker.snapshot);
    retainedPicker=next;picker=null;
    await new Promise<void>(resolve=>setImmediate(resolve));
    collect();const retainedAfterOldSnapshotRelease=memory();
    if(oldSnapshot.deref()!==undefined)throw new Error('Previous picker snapshot is still strongly retained after release');
    if(retainedPicker.snapshot.bodies.size!==count)throw new Error('Lost retained snapshot');
    retainedPicker=null;
    cases.push({trial,components:count,connections:connections.length,changedComponents:keysToChange,oldSnapshotReleased:true,
      initialBuildMs,allIndexesCompactionUpdateMs:rebaseMs,overlaySizesAfterCompaction:layers,
      heapBytes:{beforeIndexes:beforeHeap,afterBuildBeforeExplicitGc:heapAfterBuildBeforeGc,initialRetainedAfterGc:initialRetainedHeap,
        initialRetainedDelta:initialRetainedHeap-beforeHeap,beforeCompactionAfterGc:beforeRebaseHeap,
        afterCompactionBeforeExplicitGc:heapAfterRebaseBeforeGc,bothSnapshotsRetainedAfterGc:retainedWithBothSnapshots,
        afterOldSnapshotReleaseAfterGc:retainedAfterOldSnapshotRelease},
      cumulativeContainerMemoryPeakBytes:{afterInitialBuild:initialPeak,afterCompaction:rebasePeak},exactOldAndNewPicking:true});
  }
  return {schema_version:2,node:process.version,platform:process.platform,arch:process.arch,
    dataset:'100-column grid, spacing 200/150, rotations 0/90/180/270; batch-move enough initial objects by 30/40 to compact all four indexes',
    scope:'Three fresh builds and forced compactions per scene in one process, not browser startup; first trial and smaller scenes warm the runtime. Routing outside timers. Explicit GC outside timers; retained heap snapshots, not exact phase peaks. Cgroup peak is cumulative for the whole profiling container. Excludes React/SVG/HTTP/adjacency.',cases};
}
