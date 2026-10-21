import { useState, useMemo } from 'react';
import { ComponentSVG } from '../../components/ees/svg-components';
import { getCompSize, NATIVE_SIZES } from '../../components/ees/editor-utils';
import { connectionGeometry } from '../../components/ees/editor-geometry';
import type { ProjectGraph } from './project-graph';
export function SchemePreview({ graph }: { graph: ProjectGraph }) {
  const [selected, select] = useState<number | null>(null);
  const paths = useMemo(() => connectionGeometry(graph.components,graph.connections),[graph.components,graph.connections]);
  const component = graph.components.find(item => item.id === selected);
  const bounds = graph.components.reduce((box, item) => {
    const { w, h } = getCompSize(item.type);
    // Rotation can extend beyond the unrotated box. A surrounding square keeps
    // fitting conservative while sharing the same transform with the editor.
    const radius = Math.hypot(w, h);
    return { left: Math.min(box.left, item.x-radius), top: Math.min(box.top, item.y-radius), right: Math.max(box.right, item.x+radius), bottom: Math.max(box.bottom, item.y+radius) };
  }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const viewBox = graph.components.length ? `${bounds.left-30} ${bounds.top-30} ${Math.max(200,bounds.right-bounds.left+60)} ${Math.max(200,bounds.bottom-bounds.top+60)}` : '0 0 800 440';
  const links = graph.connections.map(item => ({ item, points: paths.get(item.id) }));
  return <div className="scheme-preview">
    <div className="scheme-preview-canvas"><svg viewBox={viewBox} aria-label={`Просмотр схемы ${graph.name}`}>
      {links.filter(link => link.points).map(({ item, points }) => <polyline key={item.id} points={points!.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={item.validationErrors?.length ? 'var(--accent-red)' : 'var(--symbol-ink)'} strokeWidth={2}><title>{`Связь ${item.id}: ${item.validationErrors?.join(', ') || 'без сохранённой диагностики'}`}</title></polyline>)}
      {graph.components.map(item => {
        const size = getCompSize(item.type);
        const native = Object.prototype.hasOwnProperty.call(NATIVE_SIZES, item.type) ? NATIVE_SIZES[item.type] : size;
        const Symbol = Object.prototype.hasOwnProperty.call(ComponentSVG, item.type) ? ComponentSVG[item.type] : undefined;
        return <g key={item.id} transform={`translate(${item.x},${item.y}) rotate(${item.rotation},${size.w/2},${size.h/2})`}>
          <g transform={`scale(${size.w/native.w},${size.h/native.h})`} className="component-svg">{Symbol ? <Symbol params={item.params} /> : <text>УГО отсутствует</text>}</g>
          <rect width={size.w} height={size.h} fill="transparent" stroke={selected === item.id ? 'var(--accent-blue)' : 'transparent'} strokeWidth={2} role="button" tabIndex={0} aria-label={`Просмотреть ${item.name || item.type}`} onClick={() => select(item.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(item.id); } }} />
          <text x={size.w/2} y={size.h+16} textAnchor="middle" fill="var(--text-primary)" fontSize={12}>{item.name || item.type}</text>
        </g>;
      })}
    </svg>{!graph.components.length && <p>Схема пока пуста</p>}</div>
    <aside className="scheme-preview-inspector"><h3>Оборудование</h3>
      <ul>{graph.components.map(item => <li key={item.id}><button className="tool-btn" aria-pressed={selected === item.id} onClick={() => select(item.id)}>{item.name || item.type}</button></li>)}</ul>
      {component && <><h3>{component.name || component.type}</h3><p>Тип: {component.type} · ревизия {component.revision}</p>
        <table><caption>Сохранённые параметры</caption><thead><tr><th>Параметр</th><th>Значение</th></tr></thead><tbody>{Object.entries(component.params).map(([key,value]) => <tr key={key}><th scope="row">{key}</th><td>{value || 'Не задано'}</td></tr>)}</tbody></table></>}
      {links.filter(link => !link.points || link.item.validationErrors?.length).map(({item,points}) => <p className="projects-error" key={item.id}>Связь {item.id}: {!points ? 'концы или порты не позволяют отобразить связь. ' : ''}{item.validationErrors?.join(', ')}</p>)}
    </aside>
  </div>;
}
