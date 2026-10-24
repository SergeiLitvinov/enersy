import {expect,test} from 'vitest';
import {limitContextKey} from './limit-context';
test('limit context ignores drawing and order but detects physical membership and connections',()=>{
  const cs=[{id:1,type:'generator',x:1},{id:2,type:'load',x:2}];
  const es=[{from:1,to:2,fromPort:'bottom',toPort:'top'}];
  const original=limitContextKey(cs,es);
  expect(limitContextKey(cs.map(c=>({...c,x:c.x+100})).reverse(),[...es].reverse())).toBe(original);
  expect(limitContextKey(cs.slice(0,1),es)).not.toBe(original);
  expect(limitContextKey(cs,[{...es[0],toPort:'left'}])).not.toBe(original);
});
