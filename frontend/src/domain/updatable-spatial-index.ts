import {SpatialIndex,type SpatialBox,type SpatialEntry} from './spatial-index';

export interface KeyedSpatialEntry<K,T> extends SpatialEntry<T>{key:K}
export interface SpatialChange<K,T>{key:K;entry:SpatialEntry<T>|null}
type Entry<K,T>=KeyedSpatialEntry<K,T>;
interface State<K,T>{base:ReadonlyMap<K,Entry<K,T>>;index:SpatialIndex<Entry<K,T>>;changes:ReadonlyMap<K,Entry<K,T>|null>;delta:SpatialIndex<Entry<K,T>>;size:number}
const own=<K,T>(key:K,entry:SpatialEntry<T>):Entry<K,T>=>({key,box:{...entry.box},value:entry.value});
const tree=<K,T>(entries:Iterable<Entry<K,T>>)=>new SpatialIndex([...entries].map(entry=>({box:entry.box,value:entry})));

/** Persistent base BVH plus a bounded replacement layer. Readers reject
 * shadowed base keys and query a small delta BVH. Rebase bounds accumulated
 * stale geometry; old snapshots remain valid throughout update/compaction.
 */
export class UpdatableSpatialIndex<K,T>{
  private constructor(private readonly state:State<K,T>){}
  static build<K,T>(entries:readonly Entry<K,T>[]):UpdatableSpatialIndex<K,T>{
    const base=new Map(entries.map(entry=>[entry.key,own(entry.key,entry)]));
    if(base.size!==entries.length)throw new Error('Duplicate spatial key');
    return new UpdatableSpatialIndex({base,index:tree(base.values()),changes:new Map(),delta:tree([]),size:base.size});
  }
  get size(){return this.state.size;}
  get overlaySize(){return this.state.changes.size;}
  get rebaseLimit(){return Math.max(64,Math.min(1024,Math.ceil(this.state.base.size/10)));}
  update(patches:readonly SpatialChange<K,T>[]):UpdatableSpatialIndex<K,T>{
    if(!patches.length)return this;
    const {base,index}=this.state,changes=new Map(this.state.changes);
    let size=this.size;
    for(const patch of patches){
      const current=changes.has(patch.key)?changes.get(patch.key):base.get(patch.key);
      if(patch.entry){
        if(!current)size++;
        changes.set(patch.key,own(patch.key,patch.entry));
      }else{
        if(current)size--;
        // An insertion removed before rebase needs no tombstone.
        if(base.has(patch.key))changes.set(patch.key,null);else changes.delete(patch.key);
      }
    }
    if(changes.size>this.rebaseLimit){
      const merged=new Map(base);
      for(const [key,entry] of changes){if(entry)merged.set(key,entry);else merged.delete(key);}
      return UpdatableSpatialIndex.build([...merged.values()]);
    }
    return new UpdatableSpatialIndex({base,index,changes,delta:tree([...changes.values()].filter((entry):entry is Entry<K,T>=>entry!==null)),size});
  }
  search(box:SpatialBox):{values:T[];visitedNodes:number}{
    const base=this.state.index.search(box),delta=this.state.delta.search(box);
    return {values:[...base.values.filter(entry=>!this.state.changes.has(entry.key)),...delta.values].map(entry=>entry.value),
      visitedNodes:base.visitedNodes+delta.visitedNodes};
  }
}
