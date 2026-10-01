import React, { useState } from 'react';
import { ComponentSVG, ComponentLibraryItem, COMPONENT_CATEGORIES } from '../svg-components';
import { NATIVE_SIZES } from '../editor-utils';
import { Icon } from '../../ui/Icon';
import './LibraryPanel.css';

interface LibraryPanelProps {
  library: ComponentLibraryItem[]; schemes: { id: number; name: string }[]; currentSchemeId?: number; theme: string;
  onThemeToggle: () => void; onCreateScheme: () => void; onSelectScheme: (id: number) => void; onDeleteScheme: (id: number) => void;
  onLibDragStart: (e: React.DragEvent, item: ComponentLibraryItem) => void;
  onAddItem: (item: ComponentLibraryItem) => void;
}
export const LibraryPanel: React.FC<LibraryPanelProps> = ({ library, schemes, currentSchemeId, theme, onThemeToggle, onCreateScheme, onSelectScheme, onDeleteScheme, onLibDragStart, onAddItem }) => {
  const [query, setQuery] = useState('');
  const filtered = library.filter(i => `${i.name} ${i.code}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <aside className="library-panel" aria-label="Каталог оборудования и схемы">
    <div className="panel-heading"><div><p className="eyebrow">Проект</p><h2>Схемы сети</h2></div><button className="icon-button" aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'} onClick={onThemeToggle}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button></div>
    <button className="tool-btn primary full-width" onClick={onCreateScheme}><Icon name="plus" /> Новая схема</button>
    <div className="schemes-list">
      {schemes.length === 0 && <p className="small-empty">Создайте первую схему, чтобы начать работу.</p>}
      {schemes.map(s => <div key={s.id} className={`scheme-row ${currentSchemeId === s.id ? 'active' : ''}`}>
        <button className="scheme-select" onClick={() => onSelectScheme(s.id)} aria-pressed={currentSchemeId === s.id}><Icon name="folder" /><span>{s.name}</span></button>
        <button className="scheme-row-delete" onClick={() => onDeleteScheme(s.id)} aria-label={`Удалить схему ${s.name}`}><Icon name="trash" width="14" height="14" /></button>
      </div>)}
    </div>
    <div className="catalog-heading"><h2>Оборудование</h2><span className="count-badge">{library.length}</span></div>
    <label className="catalog-search"><Icon name="search" /><input aria-label="Поиск оборудования" placeholder="Найти оборудование…" value={query} onChange={e => setQuery(e.target.value)} /><kbd>/</kbd></label>
    <p className="catalog-hint">Перетащите на схему или нажмите для добавления</p>
    {filtered.length === 0 && <p className="small-empty">Ничего не найдено. Попробуйте другое название.</p>}
    {Object.entries(COMPONENT_CATEGORIES).map(([cat, name]) => {
      const items = filtered.filter(i => i.category === cat);
      if (!items.length) return null;
      return <details key={cat} className="component-category" open><summary>{name}<span>{items.length}</span></summary><div className="component-list">
        {items.map(item => { const SVG = ComponentSVG[item.code]; const size = NATIVE_SIZES[item.code] || { w: 60, h: 60 }; return <button key={item.id} className="component-item" draggable onDragStart={e => onLibDragStart(e, item)} onClick={() => onAddItem(item)} disabled={!currentSchemeId} title={`Добавить: ${item.name}`}>
          <span className="symbol-tile">{SVG ? <svg viewBox={`-6 -6 ${size.w + 12} ${size.h + 12}`} className="component-preview" aria-hidden="true"><SVG /></svg> : <Icon name="box" />}</span><span>{item.name}</span>
        </button>; })}
      </div></details>;
    })}
    <div className="library-footnote"><Icon name="book" /><span>Графический символ и расчётная модель — разные сущности.</span></div>
  </aside>;
};
