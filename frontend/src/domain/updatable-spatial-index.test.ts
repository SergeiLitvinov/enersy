import {expect,test} from 'vitest';
import {UpdatableSpatialIndex,type KeyedSpatialEntry} from './updatable-spatial-index';

const box=(x:number)=>({left:x,right:x+10,top:0,bottom:10});
test('replacement, deletion, insertion and compaction preserve exact queries and old snapshots',()=>{
  const entries:KeyedSpatialEntry<number,number>[]=Array.from({length:1000},(_,key)=>({key,value:key,box:box(key*100)}));
  const before=UpdatableSpatialIndex.build(entries);
  let current=before;
  const expected=new Map(entries.map(entry=>[entry.key,entry]));
  let rebased=false;
  for(let step=0;step<240;step++){
    const key=step%3===0?step+1000:step;
    const entry=step%4===0?null:{box:box(-step*27),value:key};
    const previousOverlay=current.overlaySize;
    current=current.update([{key,entry}]);
    if(previousOverlay>0 && current.overlaySize===0)rebased=true;
    if(entry)expected.set(key,{key,...entry});else expected.delete(key);
    const q={left:-step*27-20,right:step*70+100,top:-5,bottom:20};
    const brute=[...expected.values()].filter(({box:b})=>b.left<=q.right && b.right>=q.left && b.top<=q.bottom && b.bottom>=q.top).map(e=>e.value).sort((a,b)=>a-b);
    expect(current.search(q).values.sort((a,b)=>a-b)).toEqual(brute);
    expect(current.size).toBe(expected.size);
    expect(current.overlaySize).toBeLessThanOrEqual(current.rebaseLimit);
  }
  expect(rebased).toBe(true);
  expect(before.search(box(200)).values).toEqual([2]);
  expect(before.size).toBe(1000);expect(before.overlaySize).toBe(0);
});

test('repeated moves and insertion/deletion reuse a bounded layer without stale hits or duplicates',()=>{
  let index=UpdatableSpatialIndex.build([{key:1,box:box(0),value:'object'}]);
  for(let i=1;i<=500;i++)index=index.update([{key:1,entry:{box:box(i*100),value:'moved'}}]);
  expect(index.overlaySize).toBe(1);expect(index.search(box(0)).values).toEqual([]);
  expect(index.search(box(50000)).values).toEqual(['moved']);
  const added={box:box(-200),value:'added'};
  index=index.update([{key:2,entry:added},{key:2,entry:null}]);
  expect(index.size).toBe(1);expect(index.overlaySize).toBe(1);
  const empty=index.update([{key:1,entry:null}]);
  expect(empty.size).toBe(0);expect(empty.search(box(50000)).values).toEqual([]);
  expect(index.search(box(50000)).values).toEqual(['moved']);
});

test('bounds are owned, bad patches fail atomically and closed boundary queries remain exact',()=>{
  const entry={key:1,box:box(0),value:1};
  const before=UpdatableSpatialIndex.build([entry]);
  entry.box.left=1000;
  const patch={box:box(-10),value:2};
  const next=before.update([{key:1,entry:patch}]);patch.box.left=1000;
  expect(next.search({left:0,right:0,top:10,bottom:10}).values).toEqual([2]);
  expect(before.search(box(0)).values).toEqual([1]);
  expect(()=>next.update([{key:2,entry:{box:box(NaN),value:3}}])).toThrow();
  expect(next.size).toBe(1);
  expect(()=>UpdatableSpatialIndex.build([entry,entry])).toThrow('Duplicate');
});
