export interface SpatialBox { left: number; right: number; top: number; bottom: number }
export interface SpatialEntry<T> { box: SpatialBox; value: T }
interface Node<T> { box: SpatialBox; children?: [Node<T>,Node<T>]; entries?: SpatialEntry<T>[] }
const intersects = (a: SpatialBox,b: SpatialBox) => a.left<=b.right && a.right>=b.left && a.top<=b.bottom && a.bottom>=b.top;
function valid(box: SpatialBox) {
  return Number.isFinite(box.left) && Number.isFinite(box.right) && Number.isFinite(box.top) && Number.isFinite(box.bottom)
    && box.left<=box.right && box.top<=box.bottom;
}

/** In-place three-way median selection. Equal centres finish in one pass;
 * a bounded partition budget falls back to sorting the remaining range.
 */
function selectMedian<T>(items:SpatialEntry<T>[],start:number,end:number,target:number,horizontal:boolean){
  const centre=(entry:SpatialEntry<T>)=>horizontal?entry.box.left/2+entry.box.right/2:entry.box.top/2+entry.box.bottom/2;
  let left=start,right=end-1,budget=2*Math.ceil(Math.log2(end-start));
  while(left<right){
    // Native sorting is cheap on small partitions and avoids spending the
    // partition machinery on the bottom levels of the tree.
    if(right-left<32 || budget--<=0){
      const sorted=items.slice(left,right+1).sort((a,b)=>centre(a)-centre(b));
      for(let i=0;i<sorted.length;i++)items[left+i]=sorted[i];
      return;
    }
    const a=centre(items[left]),b=centre(items[Math.floor((left+right)/2)]),c=centre(items[right]);
    const pivot=Math.max(Math.min(a,b),Math.min(Math.max(a,b),c));
    let lower=left,scan=left,upper=right;
    while(scan<=upper){
      const value=centre(items[scan]);
      if(value<pivot){const entry=items[scan];items[scan++]=items[lower];items[lower++]=entry;}
      else if(value>pivot){const entry=items[scan];items[scan]=items[upper];items[upper--]=entry;}
      else scan++;
    }
    if(target<lower)right=lower-1;else if(target>upper)left=upper+1;else return;
  }
}

function extent<T>(items:SpatialEntry<T>[],start:number,end:number):SpatialBox{
  const box={left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity};
  for(let i=start;i<end;i++){
    const bounds=items[i].box;
    box.left=Math.min(box.left,bounds.left);box.right=Math.max(box.right,bounds.right);
    box.top=Math.min(box.top,bounds.top);box.bottom=Math.max(box.bottom,bounds.bottom);
  }
  return box;
}

// Retain native sorting for small indexes: partition setup/JIT can outweigh
// its benefit there. Extent calculation still avoids per-entry allocations.
function sortedTree<T>(items:SpatialEntry<T>[]):Node<T>{
  const box=extent(items,0,items.length);
  if(items.length<=8)return {box,entries:items};
  const horizontal=box.right-box.left>=box.bottom-box.top;
  const centre=(entry:SpatialEntry<T>)=>horizontal?entry.box.left/2+entry.box.right/2:entry.box.top/2+entry.box.bottom/2;
  items.sort((a,b)=>centre(a)-centre(b));
  const middle=Math.floor(items.length/2);
  return {box,children:[sortedTree(items.slice(0,middle)),sortedTree(items.slice(middle))]};
}

/** Immutable median BVH. No global state, fixed cell size, or coordinate grid.
 * Build for a geometry snapshot; exact shape tests remain the caller's job.
 */
export class SpatialIndex<T> {
  private readonly root: Node<T> | null;
  constructor(entries: readonly SpatialEntry<T>[]) {
    if(entries.some(e=>!valid(e.box))) throw new Error('Invalid spatial bounds');
    // Own the bounds too: later edits must not corrupt an earlier snapshot.
    const items=entries.map(entry=>({box:{...entry.box},value:entry.value}));
    const build = (start:number,end:number): Node<T> => {
      const box=extent(items,start,end);
      if(end-start<=8) return {box,entries:items.slice(start,end)};
      const horizontal=box.right-box.left>=box.bottom-box.top;
      const middle=Math.floor((start+end)/2);
      selectMedian(items,start,end,middle,horizontal);
      return {box,children:[build(start,middle),build(middle,end)]};
    };
    this.root=items.length?(items.length<=4096?sortedTree(items):build(0,items.length)):null;
  }
  search(box: SpatialBox): {values:T[];visitedNodes:number} {
    const values:T[]=[];
    if(!valid(box) || !this.root) return {values,visitedNodes:0};
    const stack=[this.root]; let visitedNodes=0;
    while(stack.length) {
      const node=stack.pop()!; visitedNodes++;
      if(!intersects(node.box,box)) continue;
      if(node.children) stack.push(...node.children);
      else for(const e of node.entries!) if(intersects(e.box,box)) values.push(e.value);
    }
    return {values,visitedNodes};
  }
}
