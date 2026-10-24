/** Equipment terminals belong to physical topology, never drawing coordinates.
 * Called on committed editor snapshots, not pointer-move preview geometry. */
export function limitContextKey(components: readonly {id:number;type:string}[], connections: readonly {from:number;to:number;fromPort:string;toPort:string}[]): string {
  return JSON.stringify([
    components.map(c=>[c.id,c.type] as const).sort((a,b)=>a[0]-b[0]),
    connections.map(c=>JSON.stringify([c.from,c.to,c.fromPort,c.toPort])).sort(),
  ]);
}
