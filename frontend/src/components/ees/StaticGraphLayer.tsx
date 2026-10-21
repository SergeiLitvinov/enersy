import { memo,type ReactNode } from 'react';
import type { EditorComponent,EditorConnection } from './editor-utils';

/** Retain the committed SVG subtree while the drag overlay changes position. */
export const StaticComponentLayer=memo(function StaticComponentLayer({components,hiddenId,render}:{
  components:EditorComponent[];hiddenId?:number;render:(component:EditorComponent)=>ReactNode;
}) {
  return <g data-graph-layer="components">{components.filter(c=>c.id!==hiddenId).map(render)}</g>;
});

export const StaticConnectionLayer=memo(function StaticConnectionLayer({connections,hidden,render}:{
  connections:EditorConnection[];hidden?:EditorConnection[];render:(connection:EditorConnection)=>ReactNode;
}) {
  const ids=new Set(hidden?.map(c=>c.id));
  return <g data-graph-layer="connections">{connections.filter(c=>!ids.has(c.id)).map(render)}</g>;
});
