import {useLayoutEffect,useMemo,useRef} from 'react';
import {updateConnectionGeometry,type RouteSnapshot} from '../editor-route-cache';
import type {EditorComponent,EditorConnection} from '../editor-utils';

export function useConnectionGeometry(components:EditorComponent[],connections:EditorConnection[],scope:unknown){
  const committed=useRef<RouteSnapshot|null>(null);
  const snapshot=useMemo(()=>updateConnectionGeometry(committed.current,components,connections,scope),[components,connections,scope]);
  // Publish only a committed React render. Abandoned renders cannot replace
  // the cache used by the next update; the pure builder never edits old maps.
  useLayoutEffect(()=>{committed.current=snapshot;},[snapshot]);
  return snapshot.paths;
}
