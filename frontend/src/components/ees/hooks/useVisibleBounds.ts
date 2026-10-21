import {useLayoutEffect,useMemo,useState,type RefObject} from 'react';
import {visibleWorldBounds} from '../editor-viewport';
import type {ViewBox} from '../editor-utils';

export function useVisibleBounds(container:RefObject<HTMLDivElement|null>,view:ViewBox) {
  const [size,setSize]=useState<{width:number;height:number}|null>(null);
  useLayoutEffect(()=>{
    const element=container.current;if(!element)return;
    let active=true;
    const measure=()=>{
      if(!active)return;
      const {width,height}=element.getBoundingClientRect();
      setSize(previous=>previous?.width===width && previous.height===height?previous:{width,height});
    };
    measure();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
    observer?.observe(element);window.addEventListener('resize',measure);
    return()=>{active=false;observer?.disconnect();window.removeEventListener('resize',measure);};
  },[container]);
  return useMemo(()=>{
    if(!size || size.width<=0 || size.height<=0)return null;
    try{return visibleWorldBounds(view,size.width,size.height);}catch{return null;}
  },[size,view]);
}
