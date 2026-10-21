export interface SpatialBox { left: number; right: number; top: number; bottom: number }
export interface SpatialEntry<T> { box: SpatialBox; value: T }
interface Node<T> { box: SpatialBox; children?: [Node<T>,Node<T>]; entries?: SpatialEntry<T>[] }
const intersects = (a: SpatialBox,b: SpatialBox) => a.left<=b.right && a.right>=b.left && a.top<=b.bottom && a.bottom>=b.top;
function valid(box: SpatialBox) {
  return [box.left,box.right,box.top,box.bottom].every(Number.isFinite) && box.left<=box.right && box.top<=box.bottom;
}

/** Immutable median BVH. No global state, fixed cell size, or coordinate grid.
 * Build for a geometry snapshot; exact shape tests remain the caller's job.
 */
export class SpatialIndex<T> {
  private readonly root: Node<T> | null;
  constructor(entries: readonly SpatialEntry<T>[]) {
    if(entries.some(e=>!valid(e.box))) throw new Error('Invalid spatial bounds');
    const build = (items: SpatialEntry<T>[]): Node<T> => {
      const box=items.reduce((b,e)=>({left:Math.min(b.left,e.box.left),right:Math.max(b.right,e.box.right),
        top:Math.min(b.top,e.box.top),bottom:Math.max(b.bottom,e.box.bottom)}),
        {left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity});
      if(items.length<=8) return {box,entries:items};
      const horizontal=box.right-box.left>=box.bottom-box.top;
      const center=(b:SpatialBox)=>horizontal ? b.left/2+b.right/2 : b.top/2+b.bottom/2;
      items.sort((a,b)=>center(a.box)-center(b.box));
      const middle=Math.floor(items.length/2);
      return {box,children:[build(items.slice(0,middle)),build(items.slice(middle))]};
    };
    // Own the bounds too: later edits must not corrupt an earlier snapshot.
    this.root=entries.length ? build(entries.map(e=>({box:{...e.box},value:e.value}))) : null;
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
