import {useLayoutEffect,useMemo,useRef} from 'react';
import {createEditorPicker,type EditorPickerSnapshot} from '../editor-picking';
import type {Point} from '../editor-geometry';
import type {EditorComponent,EditorConnection} from '../editor-utils';

export function useEditorPicker(components:EditorComponent[],connections:EditorConnection[],paths:ReadonlyMap<number,Point[]|null>,scope:unknown){
  const committed=useRef<EditorPickerSnapshot|null>(null);
  const picker=useMemo(()=>createEditorPicker(components,connections,paths,committed.current,scope),[components,connections,paths,scope]);
  useLayoutEffect(()=>{committed.current=picker.snapshot;},[picker]);
  return picker;
}
