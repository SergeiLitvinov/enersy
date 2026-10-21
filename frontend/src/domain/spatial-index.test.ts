import { expect,test } from 'vitest';
import { SpatialIndex } from './spatial-index';

test('empty, point, boundary and negative-coordinate queries retain closed bounds',()=>{
  const box={left:-10,right:10,top:-20,bottom:20};
  const index=new SpatialIndex([{box,value:'box'}]);
  expect(index.search({left:10,right:10,top:20,bottom:20}).values).toEqual(['box']);
  expect(index.search({left:11,right:11,top:0,bottom:0}).values).toEqual([]);
  box.left=1000;
  expect(index.search({left:0,right:0,top:0,bottom:0}).values).toEqual(['box']);
  expect(new SpatialIndex([]).search({left:0,right:0,top:0,bottom:0}).visitedNodes).toBe(0);
});

test('invalid input bounds are rejected and invalid queries do not traverse the index',()=>{
  expect(()=>new SpatialIndex([{box:{left:0,right:NaN,top:0,bottom:0},value:1}])).toThrow();
  const index=new SpatialIndex([{box:{left:0,right:1,top:0,bottom:1},value:1}]);
  expect(index.search({left:1,right:-1,top:0,bottom:0})).toEqual({values:[],visitedNodes:0});
});

test('BVH agrees with an independent brute force search and prunes a large sparse scene',()=>{
  const entries=Array.from({length:10000},(_,i)=>({value:i,
    box:{left:(i%100)*200-10000,right:(i%100)*200-9990,top:Math.floor(i/100)*150,bottom:Math.floor(i/100)*150+20}}));
  const index=new SpatialIndex(entries);
  for(let k=0;k<200;k++) {
    const q={left:(k*137)%20000-10000,right:(k*137)%20000-9970,top:(k*71)%15000,bottom:(k*71)%15000+40};
    const expected=entries.filter(({box:b})=>b.left<=q.right && b.right>=q.left && b.top<=q.bottom && b.bottom>=q.top).map(e=>e.value);
    const actual=index.search(q);
    expect(actual.values.sort((a,b)=>a-b)).toEqual(expected);
    expect(actual.visitedNodes).toBeLessThan(200);
  }
});

test('median partition handles sorted, reverse, tied, nested and organ-pipe layouts without changing inputs',()=>{
  for(const count of [0,1,8,9,16,257,1000,5000])for(const layout of ['sorted','reverse','tied','nested','organ-pipe']){
    const entries=Array.from({length:count},(_,i)=>{
      const x=layout==='organ-pipe'?Math.min(i,count-1-i)*11:i*11;
      const box=layout==='tied'?{left:-5,right:5,top:-5,bottom:5}:layout==='nested'
        ?{left:-i,right:i,top:-i/2,bottom:i/2}:{left:x,right:x+10,top:-i%13,bottom:20};
      return {box,value:i};
    });
    if(layout==='reverse')entries.reverse();
    const input=JSON.stringify(entries),index=new SpatialIndex(entries);
    for(let q=0;q<30;q++){
      const box={left:q*31-100,right:q*31+20,top:-50,bottom:50};
      const expected=entries.filter(({box:b})=>b.left<=box.right && b.right>=box.left && b.top<=box.bottom && b.bottom>=box.top).map(e=>e.value).sort((a,b)=>a-b);
      expect(index.search(box).values.sort((a,b)=>a-b)).toEqual(expected);
    }
    expect(JSON.stringify(entries)).toBe(input);
  }
});

test('finite extreme coordinates do not overflow median centres or lose boundary hits',()=>{
  const entries=Array.from({length:50},(_,i)=>({value:i,box:{left:i%2?-1e308:1e308,right:i%2?-1e308:1e308,top:i,bottom:i+1}}));
  const index=new SpatialIndex(entries);
  expect(index.search({left:1e308,right:1e308,top:20,bottom:21}).values.sort((a,b)=>a-b)).toEqual([20]);
  expect(index.search({left:-1e308,right:1e308,top:-1,bottom:51}).values.sort((a,b)=>a-b)).toEqual(entries.map(e=>e.value));
});
